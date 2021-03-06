import { Processor, ProcessorEvent } from '../core/processor';
import { SocketDescriptor, SocketType, InputSocket, OutputSocket, SocketTemplateGenerator } from '../core/socket';
import { Packet } from '../core/packet';
import { BufferSlice } from '../core/buffer';
import { BufferProperties } from '../core/buffer-props';
import { CommonMimeTypes, CommonCodecFourCCs, MimetypePrefix } from '../core/payload-description';
import { ShadowOutputSocket } from '../core/socket-output';

import { printNumberScaledAtDecimalOrder } from '../common-utils';
import { getLogger, LoggerLevel } from '../logger';

import { MPEG_TS_TIMESCALE_HZ } from './mpeg2ts/mpeg2ts-utils';

import { debugNALU, H264NaluType, parseNALU } from './h264/h264-tools';

import { H264ParameterSetParser } from '../ext-mod/inspector.js/src/codecs/h264/param-set-parser';

import {
  M2tDemuxPipeline,
  M2tH264StreamEvent,
  M2tStream,
  M2tADTSStreamEvent,
  M2tPacketStreamProgramTableEvent,
  M2tNaluType,
  M2tElementaryStreamEvent
} from './muxjs-m2t/muxjs-m2t-types';

import {
  TransportPacketStream,
  TransportParseStream,
  ElementaryStream,
  TimestampRolloverStream,
  AdtsStream,
  H264Codec,
  mapNaluTypeToTag
} from './muxjs-m2t/muxjs-m2t';

/*
import * as AacStream from '../ext-mod/mux.js/lib/aac';
import {isLikelyAacData} from '../ext-mod/mux.js/lib/aac/utils';
import {ONE_SECOND_IN_TS} from '../ext-mod/mux.js/lib/utils/clock';
*/

const { debug, log, info, warn } = getLogger('MP2TSDemuxProcessor', LoggerLevel.OFF, true);

const perf = performance;

const getSocketDescriptor: SocketTemplateGenerator =
  SocketDescriptor.createTemplateGenerator(
    SocketDescriptor.fromMimeTypes('video/mp2t'), // valid inputs
    SocketDescriptor.fromMimeTypes('audio/mpeg', 'audio/aac', 'video/aac', 'application/cea-608') // output
  );

type VideoNALUInfo = {
  nalu: M2tH264StreamEvent,
  dts: number, cto: number,
  isKeyframe: boolean,
  isHeader: boolean
};

export class MP2TSDemuxProcessor extends Processor {
  static getName (): string {
    return 'MP2TSDemuxProcessor';
  }

  private _demuxPipeline: M2tDemuxPipeline;

  private _pmtCache: M2tPacketStreamProgramTableEvent;

  private _audioSocket: OutputSocket = null;
  private _audioDtsOffset: number = null;

  private _videoSocket: OutputSocket = null;
  private _videoFirstKeyFrameDts: number = null;
  private _videoConfig: M2tH264StreamEvent = null;
  private _gotVideoPictureParamSet: boolean = false;
  private _videoTimingQueueIn: M2tH264StreamEvent[] = [];
  private _videoNaluQueueOut: VideoNALUInfo[] = [];

  private _metadataSocketMap: {[pid: number]: OutputSocket} = {};

  private _outPackets: Packet[] = [];

  constructor () {
    super();
    this.createInput();

    this._setupPipeline();
  }

  templateSocketDescriptor (socketType: SocketType): SocketDescriptor {
    return getSocketDescriptor(socketType);
  }

  private _setupPipeline () {
    const pipeline: Partial<M2tDemuxPipeline> = {};

    // set up the parsing pipeline
    pipeline.packetStream = new TransportPacketStream() as unknown as M2tStream;
    pipeline.parseStream = new TransportParseStream() as unknown as M2tStream;
    pipeline.elementaryStream = new ElementaryStream() as unknown as M2tStream;
    pipeline.timestampRolloverStream = new TimestampRolloverStream(null) as unknown as M2tStream;
    // payload demuxers
    // eslint-disable-next-line new-cap
    pipeline.aacOrAdtsStream = new AdtsStream.default() as unknown as M2tStream;
    pipeline.h264Stream = new H264Codec.H264Stream() as unknown as M2tStream;
    // easy handle to headend of pipeline
    pipeline.headOfPipeline = pipeline.packetStream as unknown as M2tStream;

    // disassemble MPEG2-TS packets into elementary streams
    pipeline.packetStream
      .pipe(pipeline.parseStream)
      .pipe(pipeline.elementaryStream)
      .pipe(pipeline.timestampRolloverStream);

    pipeline.parseStream.on('data', (data: M2tPacketStreamProgramTableEvent) => {
      if (!this._pmtCache && data.type === 'pmt') {
        log('First PMT packet:', data);
        this._pmtCache = data;
        const avMimeTypes: MimetypePrefix[] = [];
        if (data.programMapTable?.audio) {
          avMimeTypes.push(MimetypePrefix.AUDIO);
        }
        if (data.programMapTable?.video) {
          avMimeTypes.push(MimetypePrefix.VIDEO);
        }
        this.emitEvent(ProcessorEvent.OUTPUT_SOCKET_SHADOW, {
          socket: new ShadowOutputSocket(avMimeTypes)
        });

        Object.keys(data.programMapTable['timed-metadata']).forEach((pid: string) => {
          const streamType: number = data.programMapTable['timed-metadata'][pid];
          // TODO: extract stream-descriptors from PMT data
          this.emitEvent(ProcessorEvent.OUTPUT_SOCKET_SHADOW, {
            socket: new ShadowOutputSocket([MimetypePrefix.APPLICATION], Number(pid))
          });
        });
      }
    });

    pipeline.elementaryStream.on('data', (data: M2tElementaryStreamEvent) => {
      if (!this._pmtCache) return;
      const appDataStreamType =
        this._pmtCache.programMapTable['timed-metadata'][data.trackId];
      if (!appDataStreamType) {
        return;
      }
      const bs = BufferSlice.fromTypedArray(data.data,
        new BufferProperties(MimetypePrefix.APPLICATION + '/unknown'));
      const timestamp = Number.isFinite(data.dts) ? data.dts : data.pts;
      let packet: Packet;
      if (Number.isFinite(timestamp)) {
        packet = Packet.fromSlice(bs, timestamp);
      } else {
        packet = Packet.fromSlice(bs);
      }
      packet.setSynchronizationId(data.trackId);
      if (!this._metadataSocketMap[data.trackId]) {
        this._metadataSocketMap[data.trackId] =
          this.createOutput(SocketDescriptor.fromPayloads(
            [packet.defaultPayloadInfo]
          ));
      }
      this._metadataSocketMap[data.trackId].transfer(packet);
    });

    // demux the streams
    pipeline.timestampRolloverStream
      .pipe(pipeline.h264Stream);

    pipeline.timestampRolloverStream
      .pipe(pipeline.aacOrAdtsStream);

    pipeline.h264Stream.on('data', (data: M2tH264StreamEvent) => {
      log('h264Stream:', data);

      this._handleVideoNalu(data);
    });

    pipeline.aacOrAdtsStream.on('data', (data: M2tADTSStreamEvent) => {
      log('aacOrAdtsStream:', data);
      this._handleAudioNalu(data);
    });

    this._demuxPipeline = pipeline as M2tDemuxPipeline;
  }

  private _handleAudioNalu (adtsEvent: M2tADTSStreamEvent) {
    const dts = adtsEvent.dts - this._audioDtsOffset;
    const cto = adtsEvent.pts - adtsEvent.dts;

    const sampleData: Uint8Array = adtsEvent.data;

    const bufferSlice = new BufferSlice( // fromTypedArray
      sampleData.buffer,
      sampleData.byteOffset,
      sampleData.byteLength);

    const packet = Packet.fromSlice(bufferSlice,
      dts,
      cto
    );

    const mimeType = CommonMimeTypes.AUDIO_AAC;

    // NOTE: buffer-props is per-se not cloned on packet transfer,
    // so we must create/ref a single prop-object per packet (full-ownership).
    bufferSlice.props = new BufferProperties(mimeType, adtsEvent.samplerate, 16, 1); // Q: is it always 16 bit ?
    bufferSlice.props.samplesCount = adtsEvent.sampleCount;
    bufferSlice.props.codec = CommonCodecFourCCs.mp4a;
    bufferSlice.props.isKeyframe = true;
    bufferSlice.props.isBitstreamHeader = false;
    bufferSlice.props.details.samplesPerFrame = 1024; // AAC has constant samples-per-frame rate of 1024
    bufferSlice.props.details.codecProfile = adtsEvent.audioobjecttype;
    bufferSlice.props.details.numChannels = adtsEvent.channelcount;

    // TODO: compute bitrate
    // bufferSlice.props.details.constantBitrate =

    if (this._audioDtsOffset === null) {
      // this._audioDtsOffset = adtsEvent.dts
      this._audioDtsOffset = 0;
    }

    // packet.setTimestampOffset(this._audioDtsOffset);
    packet.setTimescale(MPEG_TS_TIMESCALE_HZ);

    this._outPackets.push(packet);
  }

  private _handleVideoNalu (h264Event: M2tH264StreamEvent) {
    if (h264Event.config) {
      this._videoConfig = h264Event;
      info('Got video codec config slice:', this._videoConfig);
      info('Parsed SPS:', H264ParameterSetParser.parseSPS(this._videoConfig.data.subarray(1)));
    }

    if (!this._videoConfig) {
      warn('Skipping H264 data before got first param-sets, NALU-type:', mapNaluTypeToTag(h264Event.nalUnitType));
      return;
    }

    const naluParsed = parseNALU(BufferSlice.fromTypedArray(h264Event.data));

    // drop "filler data" nal-units (used by some encoders on CBR channels)
    if (naluParsed.nalType === H264NaluType.FIL) {
      return;
    }

    if (h264Event.nalUnitType === M2tNaluType.SEI) {
      return;
    }

    if (h264Event.nalUnitType === M2tNaluType.PPS) {
      this._gotVideoPictureParamSet = true;
    }

    const isKeyframe: boolean = h264Event.nalUnitType === M2tNaluType.IDR;
    if (isKeyframe) {
      if (this._videoFirstKeyFrameDts === null) {
        this._videoFirstKeyFrameDts = h264Event.dts;
      }
      if (!this._gotVideoPictureParamSet) {
        warn('Got IDR without previously seeing a PPS NALU');
      }
    }

    const isHeader: boolean = h264Event.nalUnitType === M2tNaluType.SPS ||
                              h264Event.nalUnitType === M2tNaluType.PPS;

    const dts = h264Event.dts;
    const cto = h264Event.pts - h264Event.dts;

    this._pushVideoNalu({ nalu: h264Event, dts, cto, isKeyframe, isHeader });
  }

  private _pushVideoNalu (nalInfo: VideoNALUInfo) {
    const { isHeader: nextIsHeader, isKeyframe: nextIsKeyFrame } = nalInfo;
    const nextIsAuDelimiter = nalInfo.nalu.nalUnitType === M2tNaluType.AUD;
    const firstIsAuDelimiter =
      this._videoNaluQueueOut.length
        ? this._videoNaluQueueOut[0]
          .nalu.nalUnitType === M2tNaluType.AUD
        : false;
    const lastIsAuDelimiter =
      this._videoNaluQueueOut.length
        ? this._videoNaluQueueOut[this._videoNaluQueueOut.length - 1]
          .nalu.nalUnitType === M2tNaluType.AUD
        : false;
    const hasIncrPts = this._videoNaluQueueOut.length
      ? nalInfo.nalu.pts - this._videoNaluQueueOut[0].nalu.pts > 0
      : false;

    const needQueueFlushNoAud = (hasIncrPts && !nextIsKeyFrame &&
      !(firstIsAuDelimiter || lastIsAuDelimiter || nextIsAuDelimiter));

    const needQueueFlush = this._videoNaluQueueOut.length &&
                          (
                            needQueueFlushNoAud ||
                            // seperate by AUD always
                            nextIsAuDelimiter ||
                            (!lastIsAuDelimiter &&
                              ((this._videoNaluQueueOut[0].isHeader && !nextIsHeader) ||
                                (!this._videoNaluQueueOut[0].isHeader && nextIsHeader))));

    if (needQueueFlush) {
      this._flushVideoNaluQueueOut();
    }
    this._videoNaluQueueOut.push(nalInfo);
  }

  private _flushVideoNaluQueueOut () {
    const { dts, cto, nalu, isKeyframe, isHeader } = this._videoNaluQueueOut[0];

    const props = new BufferProperties(
      CommonMimeTypes.VIDEO_H264
    );
    props.samplesCount = 1;

    props.codec = CommonCodecFourCCs.avc1;
    props.elementaryStreamId = nalu.trackId;

    props.isKeyframe = isKeyframe;
    props.isBitstreamHeader = isHeader;

    props.details.width = this._videoConfig.config.width;
    props.details.height = this._videoConfig.config.height;
    props.details.codecProfile = this._videoConfig.config.profileIdc;

    props.details.samplesPerFrame = 1;

    props.tags.add('nalu');
    // add NALU type tags for all slices
    this._videoNaluQueueOut.forEach(({ nalu, isHeader, isKeyframe }) => {
      if (isHeader) {
        props.isBitstreamHeader = true;
      }
      if (isKeyframe) {
        props.isKeyframe = true;
      }
      const naluTag = mapNaluTypeToTag(nalu.nalUnitType);
      // may be null for non-IDR-slice
      if (naluTag) {
        props.tags.add(naluTag);
      }
    });

    // create multi-slice packet
    const slices = this._videoNaluQueueOut.map(({ nalu }) => {
      const bs = new BufferSlice(
        nalu.data.buffer,
        nalu.data.byteOffset,
        nalu.data.byteLength,
        props // share same props for all slices
      );
      debugNALU(bs, debug);
      return bs;
    });

    const packet = Packet.fromSlices(
      dts,
      cto,
      ...slices
    );

    // packet.setTimestampOffset(this._videoDtsOffset); // check if this works out downstream
    packet.setTimescale(MPEG_TS_TIMESCALE_HZ);
    debug('created/pushed packet:', packet.toString(), `(${packet.getTotalBytes()} bytes in ${packet.dataSlicesLength} buffer-slices)`);
    this._outPackets.push(packet);

    this._videoNaluQueueOut.length = 0;
  }

  private _onOutPacketsPushed () {
    const outputPackets: Packet[] = this._outPackets;

    let audioSocket: OutputSocket = this._audioSocket;
    let videoSocket: OutputSocket = this._videoSocket;

    outputPackets.forEach((p: Packet) => {
      if (p.isSymbolic()) {
        log('got symbolic packet:', p.getSymbolName(), '(noop/ignoring)');
        return;
      }

      debug(`processing non-symbolic packet of ${p.getTotalBytes()} bytes`);

      if (!p.defaultPayloadInfo) {
        warn('packet has not default payload, dropping:', p.toString(), 'object:', p);
        return;
      }

      // FIXME: make two queues (audio/video) and optimize away this check here
      if (p.defaultPayloadInfo.isVideo()) {
        debug('got video packet:', p.toString());

        if (!videoSocket) {
          log('creating video output socket:', p.defaultPayloadInfo);
          this._videoSocket = videoSocket = this.createOutput(SocketDescriptor.fromPayloads([p.defaultPayloadInfo]));
        }

        // p.forEachBufferSlice((bs) => debugNALU(bs));

        debug('transferring video packet to default out');

        if (p.defaultPayloadInfo.isBitstreamHeader) {
          log('found bitstream header part in packet:', p.defaultPayloadInfo.tags, p.data);
        }

        videoSocket.transfer(p);

      // FIXME: make two queues (audio/video) and optimize away this check here
      } else if (p.defaultPayloadInfo.isAudio()) {
        debug('got audio packet:', p.toString());

        if (!audioSocket) {
          log('creating audio output socket:', p.defaultPayloadInfo);
          this._audioSocket = audioSocket = this.createOutput(SocketDescriptor.fromPayloads([p.defaultPayloadInfo]));
        }

        debug('transferring audio packet to default out');

        audioSocket.transfer(p);
      } else {
        throw new Error('Unsupported payload: ' + p.defaultMimeType);
      }
    });

    this._outPackets.length = 0; // clear queue
  }

  protected processTransfer_ (inS: InputSocket, inPacket: Packet) {
    log(`feeding demuxer with chunk of ${printNumberScaledAtDecimalOrder(inPacket.getTotalBytes(), 3)} Kbytes`);
    const startDemuxingMs = perf.now();
    this._demuxPipeline.headOfPipeline.push(inPacket.data[0].getUint8Array());
    const demuxingRunTimeMs = perf.now() - startDemuxingMs;
    log(`got ${this._outPackets.length} output packets from running demuxer (perf-stats: this took ${demuxingRunTimeMs.toFixed(3)} millis doing)`);
    this._onOutPacketsPushed();
    return true;
  }
}
