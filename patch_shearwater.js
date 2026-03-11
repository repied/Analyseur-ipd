// Shearwater Protocol Constants
const END = 0xC0;
const ESC = 0xDB;
const ESC_END = 0xDC;
const ESC_ESC = 0xDD;

class ShearwaterBLE {
    constructor(device) {
        this.device = device;
        this.server = null;
        this.rx = null;
        this.tx = null;
        this.rxBuffer = [];
        this.resolvers = [];
    }

    async connect() {
        this.server = await this.device.gatt.connect();
        const service = await this.server.getPrimaryService('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
        
        this.rx = await service.getCharacteristic('6e400002-b5a3-f393-e0a9-e50e24dcca9e'); // Write
        this.tx = await service.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e'); // Notify
        
        this.tx.addEventListener('characteristicvaluechanged', this.handleNotifications.bind(this));
        await this.tx.startNotifications();
    }

    handleNotifications(event) {
        const value = new Uint8Array(event.target.value.buffer);
        // BLE chunk has [nframes, index, ...payload]
        if (value.length < 2) return;
        const payload = value.slice(2);
        
        for (let i = 0; i < payload.length; i++) {
            this.rxBuffer.push(payload[i]);
            if (payload[i] === END && this.rxBuffer.length > 1) {
                this.processPacket();
            }
        }
    }

    processPacket() {
        // SLIP decode
        let decoded = [];
        let escaped = false;
        for (let i = 0; i < this.rxBuffer.length; i++) {
            let c = this.rxBuffer[i];
            if (c === END) break;
            if (escaped) {
                if (c === ESC_END) decoded.push(END);
                else if (c === ESC_ESC) decoded.push(ESC);
                escaped = false;
            } else if (c === ESC) {
                escaped = true;
            } else {
                decoded.push(c);
            }
        }
        this.rxBuffer = []; // Reset
        
        if (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve(new Uint8Array(decoded));
        }
    }

    async transfer(commandBytes) {
        return new Promise(async (resolve, reject) => {
            this.resolvers.push(resolve);
            
            // 1. Packet header: FF 01 LEN 00 [DATA]
            let packet = [0xFF, 0x01, commandBytes.length + 1, 0x00, ...commandBytes];
            
            // 2. SLIP encode
            let slipEncoded = [];
            for (let c of packet) {
                if (c === END) slipEncoded.push(ESC, ESC_END);
                else if (c === ESC) slipEncoded.push(ESC, ESC_ESC);
                else slipEncoded.push(c);
            }
            slipEncoded.push(END);
            
            // 3. BLE chunking (32 bytes max)
            const CHUNK_SIZE = 32;
            const payloadSize = CHUNK_SIZE - 2;
            const nframes = Math.ceil(slipEncoded.length / payloadSize);
            
            for (let i = 0; i < nframes; i++) {
                let chunk = new Uint8Array(Math.min(CHUNK_SIZE, slipEncoded.length - i * payloadSize + 2));
                chunk[0] = nframes;
                chunk[1] = i;
                chunk.set(slipEncoded.slice(i * payloadSize, (i + 1) * payloadSize), 2);
                await this.rx.writeValue(chunk);
            }
            
            // Timeout if no response
            setTimeout(() => {
                const index = this.resolvers.indexOf(resolve);
                if (index > -1) {
                    this.resolvers.splice(index, 1);
                    reject(new Error("Timeout waiting for response"));
                }
            }, 5000);
        });
    }

    async rdbi(id) {
        let req = [0x22, id, 0x00];
        let res = await this.transfer(req);
        // Valid response: FF 01 LEN 00 [0x62 ID ...]
        if (res.length > 6 && res[4] === 0x62 && res[5] === id) {
            return res.slice(6); // Return payload
        }
        throw new Error("Invalid RDBI response");
    }

    async downloadBlock(address, size) {
        // Mock download to keep example concise, protocol dictates complex download handshakes
        console.log(`Downloading block at ${address.toString(16)} size ${size}...`);
        return new Uint8Array(size);
    }
}
