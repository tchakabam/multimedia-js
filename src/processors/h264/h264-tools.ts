import { BufferSlice } from "../../core/buffer";
import { BufferProperties } from "../../core/buffer-props";
import { copyArrayBuffer, copyTypedArraySlice, writeTypedArraySlice } from "../../common-utils";
import { getLogger, LoggerLevel } from "../../logger";

import { NALU } from "./nalu";
import { H264ParameterSetParser } from "../../ext-mod/inspector.js/src/codecs/h264/param-set-parser";
import { Sps, Pps } from "../../ext-mod/inspector.js/src/codecs/h264/nal-units";

const {log, warn} = getLogger('H264Tools', LoggerLevel.ON, true);

export function debugNALU(bufferSlice: BufferSlice) {
  const nalu: NALU = new NALU(bufferSlice.getUint8Array());
  log('NALU details:', nalu);
}

/**
 * An access-unit (AU) is a set of NAL (network abstraction layer) units.
 * The AU is top-most indicated slice of data that a container format would advertise as
 * a "sample" or "frame". Therefore an AU may have an externally clocked PTS/DTS timestamp pair attached to it,A
 * but must not. An AU can also be "self-contained" and can be in principle decoded
 * (but not easily seeked) as is (without external clocking index).
 *
 * @param bufferSlice
 * @param debugRbspData
 */
export function debugAccessUnit(bufferSlice: BufferSlice, debugRbspData: boolean = false) {

  const avcStream = bufferSlice.getUint8Array();
  const avcView = bufferSlice.getDataView();

  let naluLength;
  let naluCount = 0;

  for (let naluOffset = 0; naluOffset < avcStream.byteLength; naluOffset += naluLength) {
    naluLength = avcView.getUint32(naluOffset);

    if (naluLength > avcStream.length) {
      warn('no NALUs found in this data! (not an access-unit)');
      break;
    }

    naluOffset += 4;

    const naluSlice = bufferSlice.unwrap(naluOffset, naluLength);
    const naluBytes = naluSlice.getUint8Array();
    const nalu = new NALU(naluBytes);

    naluCount++;

    log('In access-unit, found NALU of type ', nalu.getTypeName(), ', of length ' + naluLength + ' bytes, #' + naluCount + ':', nalu);

    if (debugRbspData) {

      switch(nalu.nalType) {
      case NALU.SPS:
        // we need to skip first byte of NALU data
        const sps: Sps = H264ParameterSetParser.parseSPS(nalu.payload.subarray(1))
        log ('Parsed SPS:', sps);
        break;
      case NALU.PPS:
        // we need to skip first byte of NALU data
        const pps: Pps = H264ParameterSetParser.parsePPS(nalu.payload.subarray(1))
        log ('Parsed PPS:', pps);
        break;
      }
    }
  }

}

/**
 *
 * @param rbspBodyData
 * @param naluType From 0 to 31
 * @param nalRefIdc From 0 to 3
 */
export function makeNALUFromH264RbspData(
  rbspBodyData: BufferSlice,
  naluType: number,
  nalRefIdc: number,
  extensionHeaderData: ArrayBuffer = null): BufferSlice {

  let hasExtensionHeader = false;

  if(naluType ===  14 || naluType ===  20) {
    if (!extensionHeaderData) {
      throw new Error('Need extension header data');
    }
    hasExtensionHeader = true;
  }

  const naluHeader = new ArrayBuffer(hasExtensionHeader ? 4 : 1);
  const naluHeaderView = new DataView(naluHeader);

  if (naluType >= 32) {
    throw new Error('Invalid NALU type value: ' + naluType)
  }

  if (nalRefIdc >= 4) {
    throw new Error('Invalid NAL_ref_IDC value: ' + nalRefIdc)
  }

  if (extensionHeaderData && extensionHeaderData.byteLength !== 3) {
    throw new Error('Invalid extension header data size');
  }

  naluHeaderView.setUint8(0, (nalRefIdc << 5) + naluType);

  if(hasExtensionHeader) {
    copyArrayBuffer(extensionHeaderData, naluHeader, extensionHeaderData.byteLength, 0, 1)
  }

  const naluData = rbspBodyData.prepend(new BufferSlice(naluHeader), new BufferProperties('video/avc'));

  return naluData;
}

/**
 *
 * @param naluData list of NAL units in access unit
 */
export function makeAnnexBAccessUnitFromNALUs(naluData: BufferSlice[]): BufferSlice {
  const totalSizeOfNalus = BufferSlice.getTotalSize(naluData);
  const accessUnitData: BufferSlice = BufferSlice.allocateNew(4 * naluData.length + totalSizeOfNalus);
  const auDataView: DataView = accessUnitData.getDataView()

  let offset = 0;
  naluData.forEach((naluBuffer) => {
    auDataView.setUint32(offset, naluBuffer.length);
    offset += 4;
    naluBuffer.write(accessUnitData.arrayBuffer, offset);
    offset += naluBuffer.length;
  })

  return accessUnitData;
}

