const fs = require('fs');

const replacement = `// --- BLUETOOTH SHEARWATER (EXPERIMENTAL) ---
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

    async connect(logCallback) {
        this.log = logCallback || console.log;
        this.log("Connexion GATT...");
        this.server = await this.device.gatt.connect();
        
        this.log("Découverte des services...");
        const service = await this.server.getPrimaryService('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
        
        this.rx = await service.getCharacteristic('6e400002-b5a3-f393-e0a9-e50e24dcca9e'); // Write
        this.tx = await service.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e'); // Notify
        
        this.tx.addEventListener('characteristicvaluechanged', this.handleNotifications.bind(this));
        await this.tx.startNotifications();
        this.log("Bluetooth prêt !");
    }

    handleNotifications(event) {
        const value = new Uint8Array(event.target.value.buffer);
        for (let i = 0; i < value.length; i++) {
            this.rxBuffer.push(value[i]);
            if (value[i] === END) {
                if (this.rxBuffer.length > 1) {
                    this.processPacket();
                } else {
                    this.rxBuffer = []; // skip leading END
                }
            }
        }
    }

    processPacket() {
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
        this.rxBuffer = [];
        
        if (decoded.length >= 4 && decoded[0] === 0x01 && decoded[1] === 0xFF) {
            let length = decoded[2];
            let payload = decoded.slice(4, 4 + length - 1);
            if (this.resolvers.length > 0) {
                this.resolvers.shift()(new Uint8Array(payload));
            }
        }
    }

    async transfer(commandBytes, timeoutMs = 5000) {
        return new Promise(async (resolve, reject) => {
            this.resolvers.push(resolve);
            
            let packet = [0xFF, 0x01, commandBytes.length + 1, 0x00, ...commandBytes];
            
            let slipEncoded = [];
            for (let c of packet) {
                if (c === END) slipEncoded.push(ESC, ESC_END);
                else if (c === ESC) slipEncoded.push(ESC, ESC_ESC);
                else slipEncoded.push(c);
            }
            slipEncoded.push(END);
            
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
            
            setTimeout(() => {
                const index = this.resolvers.indexOf(resolve);
                if (index > -1) {
                    this.resolvers.splice(index, 1);
                    reject(new Error("Timeout du transfert Bluetooth"));
                }
            }, timeoutMs);
        });
    }

    async downloadBlock(address, size, compress = 1) {
        this.log(\`Requête du bloc mémoire \${address.toString(16)} (\${size} octets)\`);
        let req_init = [0x35, compress ? 0x10 : 0x00, 0x34, 
            (address >> 24) & 0xFF, (address >> 16) & 0xFF, (address >> 8) & 0xFF, address & 0xFF,
            (size >> 16) & 0xFF, (size >> 8) & 0xFF, size & 0xFF];
            
        let res_init = await this.transfer(req_init);
        if (res_init[0] !== 0x75 || res_init[1] !== 0x10) throw new Error("Init download échoué");
        
        let done = false;
        let block = 1;
        let nbytes = 0;
        let dynamicBuffer = [];
        
        while (nbytes < size && !done) {
            let req_block = [0x36, block];
            let res_block = await this.transfer(req_block, 20000); // 20s timeout for blocks
            if (res_block[0] !== 0x76 || res_block[1] !== block) throw new Error("Erreur de bloc " + block);
            
            let payload = res_block.slice(2);
            if (compress) {
                let res = this.decompressLRE(payload);
                dynamicBuffer.push(...res.data);
                if (res.done) done = true;
            } else {
                dynamicBuffer.push(...payload);
            }
            nbytes += payload.length;
            block++;
        }
        
        await this.transfer([0x37]); // Quit
        let result = new Uint8Array(dynamicBuffer);
        if (compress) this.decompressXOR(result);
        return result;
    }

    decompressLRE(data) {
        let nbits = data.length * 8;
        let buffer = [];
        let offset = 0;
        let done = false;
        while (offset + 9 <= nbits) {
            let byte = Math.floor(offset / 8);
            let bit = offset % 8;
            let val16 = (data[byte] << 8) | (data[byte+1] || 0);
            let shift = 16 - (bit + 9);
            let value = (val16 >> shift) & 0x1FF;
            
            if (value & 0x100) {
                buffer.push(value & 0xFF);
            } else if (value === 0) {
                done = true;
                break;
            } else {
                for(let i=0; i<value; i++) buffer.push(0);
            }
            offset += 9;
        }
        return { data: buffer, done: done };
    }

    decompressXOR(data) {
        for (let i = 32; i < data.length; ++i) {
            data[i] ^= data[i - 32];
        }
    }
}

async function connectShearwater() {
    try {
        if (!navigator.bluetooth) throw new Error("Web Bluetooth n'est pas supporté (Chrome/Edge sur Android ou PC avec HTTPS).");

        hideError();
        loadingMsg.classList.remove('hidden');
        const statusSpan = document.querySelector('#loadingMsg span');
        statusSpan.textContent = "Recherche Bluetooth...";
        dashboard.classList.add('hidden');

        const device = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: 'Petrel' }, { namePrefix: 'Perdix' }, { namePrefix: 'Teric' },
                { namePrefix: 'Peregrine' }, { namePrefix: 'Nerd' }, { namePrefix: 'Tern' }
            ],
            optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e']
        });

        const shearwater = new ShearwaterBLE(device);
        
        device.addEventListener('gattserverdisconnected', () => {
            console.log("Appareil déconnecté.");
        });

        await shearwater.connect((msg) => { statusSpan.textContent = msg; });

        // Lire le manifeste
        statusSpan.textContent = "Lecture du carnet de plongées...";
        const manifestSize = 0x600;
        const manifestAddr = 0xE0000000;
        const manifest = await shearwater.downloadBlock(manifestAddr, manifestSize, 0);
        
        // Trouver la dernière plongée valide
        let latestAddress = 0;
        for (let i = 0; i < manifest.length; i += 32) {
            let magic = (manifest[i] << 8) | manifest[i+1];
            if (magic !== 0x5A23) { // Non supprimé
                latestAddress = (manifest[i+20] << 24) | (manifest[i+21] << 16) | (manifest[i+22] << 8) | manifest[i+23];
            }
        }
        
        if (latestAddress === 0) throw new Error("Aucune plongée trouvée.");

        statusSpan.textContent = "Téléchargement de la dernière plongée...";
        const diveData = await shearwater.downloadBlock(0xC0000000 + latestAddress, 0xFFFFFF, 1);
        
        statusSpan.textContent = "Analyse de la plongée...";
        
        // Parsing simplifié de Shearwater Petrel/Predator
        const diveProfile = [];
        let timeSec = 0;
        let interval = 10;
        
        // Saut d'entête (Headersize approx 36/60)
        let offset = 60; // heuristique standard
        const sampleSize = 12; // PNF/Petrel 
        
        while (offset + sampleSize <= diveData.length) {
            let empty = true;
            for(let k=0; k<sampleSize; k++) if(diveData[offset+k] !== 0) { empty = false; break; }
            if (empty) { offset += sampleSize; continue; }
            
            let type = diveData[offset]; // PNF record type
            if (type === 0x05) { // 0x05 = LOG_RECORD_DIVE_SAMPLE
                timeSec += interval;
                let depth16 = (diveData[offset+1] << 8) | diveData[offset+2];
                let depth = depth16 / 10.0;
                
                diveProfile.push({
                    x: timeSec / 60.0,
                    y: Math.max(0, depth),
                    speed: 0,
                    phase: 'bottom'
                });
            }
            offset += sampleSize;
        }

        if (diveProfile.length === 0) {
            throw new Error("Impossible d'extraire la courbe de la plongée téléchargée.");
        }

        runAnalysis(diveProfile);
        
    } catch (error) {
        console.error("Erreur Bluetooth:", error);
        showError("Erreur Bluetooth: " + error.message);
        loadingMsg.classList.add('hidden');
        document.querySelector('#loadingMsg span').textContent = "Analyse Télémétrique...";
    }
}`;

const appPath = 'src/js/app.js';
let content = fs.readFileSync(appPath, 'utf8');

// Supprimer le bloc précédent // --- BLUETOOTH SHEARWATER (EXPERIMENTAL) --- jusqu'à la fin
const marker = "// --- BLUETOOTH SHEARWATER (EXPERIMENTAL) ---";
if (content.includes(marker)) {
    content = content.split(marker)[0];
}

content += replacement;
fs.writeFileSync(appPath, content);
