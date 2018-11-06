import { Processor, ProcessorEvent, ProcessorEventData } from '../core/processor';
import { Packet, PacketSymbol } from '../core/packet';
import { InputSocket, SocketDescriptor, SocketType, SocketTemplateGenerator } from '../core/socket';

// This version of our mp4-mux processor is based on the mozilla rtmpjs code
import {
  MP4Mux,
  MP4Track,
  MP4Metadata,
  AUDIO_PACKET,
  VIDEO_PACKET,
  MP3_SOUND_CODEC_ID,
  AAC_SOUND_CODEC_ID,
  AVC_VIDEO_CODEC_ID,
  VP6_VIDEO_CODEC_ID
} from './mozilla-rtmpjs/mp4mux';

import { isNumber } from '../common-utils';
import { getLogger } from '../logger';

const { log, warn } = getLogger('MP4MuxProcessor(Moz)');

function getCodecId (codec: MP4MuxProcessorSupportedCodecs): number {
  switch (codec) {
  case MP4MuxProcessorSupportedCodecs.AAC:
    return AAC_SOUND_CODEC_ID;
  case MP4MuxProcessorSupportedCodecs.MP3:
    return MP3_SOUND_CODEC_ID;
  case MP4MuxProcessorSupportedCodecs.AVC:
    return AVC_VIDEO_CODEC_ID;
  case MP4MuxProcessorSupportedCodecs.VP6:
    return VP6_VIDEO_CODEC_ID;
  }
}

function isVideoCodec (codec: MP4MuxProcessorSupportedCodecs): boolean {
  switch (codec) {
  case MP4MuxProcessorSupportedCodecs.AAC:
  case MP4MuxProcessorSupportedCodecs.MP3:
    return false;
  case MP4MuxProcessorSupportedCodecs.AVC:
  case MP4MuxProcessorSupportedCodecs.VP6:
    return true;
  }
}

const VIDEO_TRACK_DEFAULT_TIMESCALE = 12800;

const getSocketDescriptor: SocketTemplateGenerator =
  SocketDescriptor.createTemplateGenerator(
      SocketDescriptor.fromMimeTypes('audio/mpeg', 'audio/aac', 'video/aac'), // valid inputs
      SocketDescriptor.fromMimeTypes('audio/mp4', 'video/mp4')); // possible output

export enum MP4MuxProcessorSupportedCodecs {
  AVC = 'avc',
  AAC = 'mp4a',
  MP3 = 'mp3',
  VP6 = 'vp6f'
}

export class MP4MuxProcessor extends Processor {

  private mp4Muxer_: MP4Mux = null;
  private mp4Metadata_: MP4Metadata = null;
  private _hasBeenClosed: boolean = false;
  private keyFramePushed_: boolean = false;
  private lastCodecInfo_: string[] = [];

  private videoPacketQueue_: Packet[] = [];
  private audioPacketQueue_: Packet[] = [];

  constructor () {
    super();

    this.createOutput();

    this._initMP4Metadata();

    this.on(ProcessorEvent.INPUT_SOCKET_CREATED,
      (eventData: ProcessorEventData) => this._onInputCreated(eventData));
  }

  templateSocketDescriptor (st: SocketType): SocketDescriptor {
    return getSocketDescriptor(st)
  }

  protected processTransfer_ (inputSocket: InputSocket, p: Packet, inputIndex: number): boolean {

    if (!p.defaultPayloadInfo) {
      warn('no default payload info:', p);
      return false;
    }

    if (p.defaultPayloadInfo.isAudio()) {

      this.audioPacketQueue_.push(p);

      if (this.mp4Metadata_.tracks[inputIndex]) {
        return true;
      }

      // FIXME: get actual infos here from input packets
      this._addAudioTrack(
        MP4MuxProcessorSupportedCodecs.AAC,
        44100,
        2,
        'und',
        60
      )

      return true;
    }

    if (p.defaultPayloadInfo.isVideo()) {

      this.videoPacketQueue_.push(p);

      if (this.mp4Metadata_.tracks[inputIndex]) {
        return true;
      }

      this._addVideoTrack(
        MP4MuxProcessorSupportedCodecs.AVC,
        // FIXME: get actual infos here from input packets
        25, // fps
        768, 576, // resolution
        60 // duration
      );

      return true;
    }

    return true;
  }

  protected handleSymbolicPacket_ (symbol: PacketSymbol): boolean {
    switch (symbol) {
    case PacketSymbol.RESUME:
      log('resume symbol received, closing state');
      this._close();
      break;
    case PacketSymbol.EOS:
      log('received EOS, flushing');
      this._flush();
    default:
      break;
    }

    return super.handleSymbolicPacket_(symbol);
  }

  private _processVideoPacket(p: Packet) {

    p.forEachBufferSlice((bufferSlice) => {
      const mp4Muxer = this.mp4Muxer_;
      const data = bufferSlice.getUint8Array();

      if (bufferSlice.props.isBitstreamHeader) {
        log('got codec init data');
      }

      log('packet timestamp/cto:', p.timestamp, p.presentationTimeOffset);

      mp4Muxer.pushPacket(
        VIDEO_PACKET,
        data,
        p.timestamp * VIDEO_TRACK_DEFAULT_TIMESCALE,
        true,
        bufferSlice.props.isBitstreamHeader,
        bufferSlice.props.isKeyframe,
        p.presentationTimeOffset * VIDEO_TRACK_DEFAULT_TIMESCALE
      );

      if (!this.keyFramePushed_ &&
        bufferSlice.props.isKeyframe) {
        this.keyFramePushed_ = true;
      }
    });
  }

  private _onInputCreated(eventData: ProcessorEventData) {
    log('input socket created');
  }

  private _initMP4Metadata () {
    this.mp4Metadata_ = {
      tracks: [],
      duration: 0,
      audioTrackId: NaN,
      videoTrackId: NaN
    };
  }

  private _initMuxer () {
    log('initMuxer() called with mp4 metadata model:', this.mp4Metadata_);

    const mp4Muxer = this.mp4Muxer_ = new MP4Mux(this.mp4Metadata_);

    mp4Muxer.ondata = this.onMp4MuxerData_.bind(this);
    mp4Muxer.oncodecinfo = this.onMp4MuxerCodecInfo_.bind(this);

    this._hasBeenClosed = true;
  }

  private _getNextTrackId (): number {
    return (this.mp4Metadata_.tracks.length + 1);
  }

  private _close () {
    log('closing state');
    if (!this._hasBeenClosed) {
      this._initMuxer();
    }

    log('processing video packet queue');

    this.videoPacketQueue_.forEach((packet: Packet) => {
      this._processVideoPacket(packet);
    });
    this.videoPacketQueue_ = [];
  }

  private _flush () {
    log('flush called');
    this._close();
    log('will flush internal muxer engine');
    this.mp4Muxer_.flush();
  }

  private _addAudioTrack (audioCodec: MP4MuxProcessorSupportedCodecs,
    sampleRate?: number, numChannels?: number, language?: string, duration?: number): MP4Track {
    if (isVideoCodec(audioCodec)) {
      throw new Error('Not an audio codec: ' + audioCodec);
    }

    let audioTrack: MP4Track = {
      duration: isNumber(duration) ? duration : -1,
      codecDescription: audioCodec,
      codecId: getCodecId(audioCodec),
      language: language || 'und',
      timescale: sampleRate || 44100,
      samplerate: sampleRate || 44100,
      channels: numChannels || 2,
      samplesize: 16
    };

    this.mp4Metadata_.audioTrackId = this._getNextTrackId();
    this.mp4Metadata_.tracks.push(audioTrack);

    return audioTrack;
  }

  private _addVideoTrack (
    videoCodec: MP4MuxProcessorSupportedCodecs,
    frameRate: number, width: number, height: number, duration?: number): MP4Track {
    if (!isVideoCodec(videoCodec)) {
      throw new Error('Not a video codec: ' + videoCodec);
    }

    let videoTrack: MP4Track = {
      duration: isNumber(duration) ? duration * VIDEO_TRACK_DEFAULT_TIMESCALE : -1,
      codecDescription: videoCodec,
      codecId: getCodecId(videoCodec),
      language: 'und',
      timescale: VIDEO_TRACK_DEFAULT_TIMESCALE,
      framerate: frameRate,
      width: width,
      height: height
    };

    log('created video track:', videoTrack);

    this.mp4Metadata_.videoTrackId = this._getNextTrackId();
    this.mp4Metadata_.tracks.push(videoTrack);

    if (isNumber(duration)) {
      this.mp4Metadata_.duration = duration * VIDEO_TRACK_DEFAULT_TIMESCALE;

      log('set duration:', this.mp4Metadata_.duration);
    }

    return videoTrack;

  }

  private onMp4MuxerData_ (data: Uint8Array) {
    const p: Packet = Packet.fromArrayBuffer(data.buffer, 'video/mp4; codecs=avc1.64001f');

    log('fmp4 data:', p);

    this.out[0].transfer(p);
  }

  private onMp4MuxerCodecInfo_ (codecInfo: string[]) {
    log('codec info:', codecInfo);

    this.lastCodecInfo_ = codecInfo;
  }
}
