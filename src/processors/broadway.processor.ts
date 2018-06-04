import { Processor } from "../core/processor";
import { SocketType, SocketDescriptor, InputSocket } from "../core/socket";
import { Packet } from "../core/packet";
import { BufferSlice } from "../core/buffer";

import * as BroadwayPlayer from '../ext-mod/Broadway/Player/Player';
import { create } from "domain";

// global node-canvas instance, only for testing !
const { createCanvas } = require('canvas')

// global SUPER DIRTY HACK for testing
BroadwayPlayer.prototype._createBasicCanvasObj = function(options) {

  console.log('create-canvas method overload');

  options = options || {};
  var obj: any = {};
  var width = options.width;
  if (!width) {
    width = this._config.size.width;
  };
  var height = options.height;
  if (!height) {
    height = this._config.size.height;
  };
  obj.canvas = createCanvas(); // document.createElement('canvas');

  //console.log(obj.canvas)

  obj.canvas.width = width;
  obj.canvas.height = height;

  obj.canvas.style = Object.create(null);

  obj.canvas.style.backgroundColor = "#0D0E1B";
  return obj;
}

export class BroadwayProcessor extends Processor {

  private _player: BroadwayPlayer = new BroadwayPlayer({
    useWorker: false,
    reuseMemory: true,
    webgl: false,
    size: {
      width: 640,
      height: 368
    }
  });

  private _canvas = createCanvas(200, 200);

  constructor() {
    super();
  }

  templateSocketDescriptor(socketType: SocketType): SocketDescriptor {
    throw new Error("Method not implemented.");
  }

  protected processTransfer_(inS: InputSocket, p: Packet) {
    p.forEachBufferSlice(
      this._onBufferSlice.bind(this, p),
      this._onProcessingError,
      this)

    return true
  }

  private _onProcessingError(bufferSlice: BufferSlice, err: Error): boolean {
    console.error('Broadway proc error:', err)

    return true;
  }

  private _onBufferSlice(p: Packet, bufferSlice: BufferSlice) {



  }
}