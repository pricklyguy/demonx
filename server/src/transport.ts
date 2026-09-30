import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import type { PortInfo } from '../../shared/protocol.js';

/** A byte pipe to a controller. Emits 'data' (string), 'close', 'error'. */
export interface Transport extends EventEmitter {
  open(): Promise<void>;
  write(data: string | Buffer): void;
  close(): Promise<void>;
}

export class SerialTransport extends EventEmitter implements Transport {
  private port: SerialPort;

  constructor(path: string, baudRate = 115200) {
    super();
    this.port = new SerialPort({ path, baudRate, autoOpen: false });
    this.port.on('data', (b: Buffer) => this.emit('data', b.toString('latin1')));
    this.port.on('close', () => this.emit('close'));
    this.port.on('error', (e) => this.emit('error', e));
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => this.port.open((e) => (e ? reject(e) : resolve())));
  }

  write(data: string | Buffer) {
    this.port.write(typeof data === 'string' ? Buffer.from(data, 'latin1') : data);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.port.isOpen) return resolve();
      this.port.close(() => resolve());
    });
  }
}

export async function listSerialPorts(): Promise<PortInfo[]> {
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer,
    description: [p.vendorId, p.productId].filter(Boolean).join(':') || undefined,
  }));
}
