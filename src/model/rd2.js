// model/rd2.js
import { SerialPort } from 'serialport';

// 定義 RFID 操作類別
class rd2 {
  constructor(portPath) {
    // 建立 SerialPort 實體，但不自動開啟
    this.port = new SerialPort({
      path: portPath,
      baudRate: 57600,
      parity: 'none',
      dataBits: 8,
      stopBits: 1,
      autoOpen: false,
    });

    this.activeTagDisplay = false; // 是否啟用主動標籤回報
    this.bufferCache = Buffer.alloc(0); // 資料緩衝區（未使用）
    this._pendingCallback = null; // 等待中處理 callback（例如 setWorkMode、setBuzzer）
    this._responseResolver = null; // 當前應答的 Promise resolver

    // 資料接收事件處理
    this.port.on('data', (data) => {
      this.parseMultipleFrames(data);
    });
  }

  // 開啟串口
  open() {
    return new Promise((resolve, reject) => {
      this.port.open(err => err ? reject(err) : resolve());
    });
  }

  // 傳送封包至設備
  send(buffer) {
    this.port.write(buffer, err => {
      if (err) console.error('發送資料失敗:', err.message);
    });
  }

  // 啟用主動標籤回報
  enableTagDisplay() {
    this.activeTagDisplay = true;
  }

  // 停用主動標籤回報
  disableTagDisplay() {
    this.activeTagDisplay = false;
  }

  // 包裝命令封包格式：標頭 + 內容 + checksum
  wrapCmd(body) {
    const base = [0x02, 0xFF, 0xFF, ...body];
    const checksum = this.calcChecksum(Buffer.from(base));
    return Buffer.concat([Buffer.from(base), Buffer.from([checksum])]);
  }

  // 計算封包 checksum（補數加總）
  calcChecksum(buffer) {
    const sum = buffer.reduce((acc, b) => acc + b, 0);
    return (~sum + 1) & 0xFF;
  }

  // 建立各種封包指令
  buildSetPowerFrame(power) {
    return this.wrapCmd([0x52, 0x00, 0x01, power]);
  }

  buildGetPowerFrame() {
    return this.wrapCmd([0x51, 0x00, 0x00]);
  }

  buildQueryBasicParamsFrame() {
    return this.wrapCmd([0x82, 0x32, 0x00]);
  }

  buildSetParamsFrame(dataField) {
    return this.wrapCmd([0x82, 0x31, dataField.length, ...dataField]);
  }

  buildRestoreFactoryFrame() {
    return this.wrapCmd([0xD4, 0x00, 0x00]);
  }

  buildRebootFrame() {
    return this.wrapCmd([0xD1, 0x00, 0x00]);
  }

  buildInventoryOnceFrame() {
    return this.wrapCmd([0x22, 0x00, 0x00]);
  }

  // ===============================
  // 對外公開的高階非同步 API
  // ===============================

  async inventoryOnce(timeout = 3000) {
    if (!this.port.isOpen) {
      throw new Error('Serial port is not open');
    }
  
    console.log('inventoryOnce 指令送出');
    return new Promise((resolve, reject) => {
      this._responseResolver = (epcList) => {
        clearTimeout(timer);
        resolve(epcList);
      };
  
      const timer = setTimeout(() => {
        this._responseResolver = null;
        reject(new Error('inventoryOnce timeout'));
      }, timeout);
  
      this.send(this.buildInventoryOnceFrame());
    });
  }   

  // 取得功率
  async getPower() {
    return await new Promise((resolve) => {
      this._responseResolver = (power) => resolve(power);
      this.send(this.buildGetPowerFrame());
    });
  }

  // 設定功率
  async setPower(power) {
    return await new Promise((resolve) => {
      this._responseResolver = () => resolve();
      this.send(this.buildSetPowerFrame(power));
    });
  }

  // 查詢基本參數
  async queryBasicParams() {
    return await new Promise((resolve) => {
      this._responseResolver = (params) => resolve(params);
      this.send(this.buildQueryBasicParamsFrame());
    });
  }

  // 設定蜂鳴器狀態（需要先查詢，再改參數）
  async setBuzzer(on) {
    return await new Promise((resolve) => {
      this._pendingCallback = (dataField) => {
        if (dataField.length >= 12) {
          const newField = Buffer.from(dataField);
          newField[11] = on ? 0x01 : 0x00; // 第 12 個 byte 是蜂鳴器控制
          this.send(this.buildSetParamsFrame(newField));
        }
        resolve();
      };
      this.send(this.buildQueryBasicParamsFrame());
    });
  }

  // 設定工作模式（命令、主動、被動）
  async setWorkMode(mode) {
    return await new Promise((resolve) => {
      this._pendingCallback = (dataField) => {
        if (dataField.length >= 12) {
          const newField = Buffer.from(dataField);
          newField[1] = mode; // 第 2 個 byte 是工作模式
          this.send(this.buildSetParamsFrame(newField));
        }
        resolve();
      };
      this.send(this.buildQueryBasicParamsFrame());
    });
  }

  // 重啟設備
  async rebootDevice() {
    return await new Promise((resolve) => {
      this._responseResolver = resolve;
      this.send(this.buildRebootFrame());
    });
  }

  // 還原出廠設定，結束後自動重啟
  async restoreFactorySettings() {
    return await new Promise((resolve) => {
      this._responseResolver = () => {
        setTimeout(() => {
          this.rebootDevice().then(resolve);
        }, 500);
      };
      this.send(this.buildRestoreFactoryFrame());
    });
  }

  // ===============================
  // 封包處理（接收邏輯）
  // ===============================

  // 取得 EPC (Tag 標籤識別碼)
  getEPCFromBuffer(buffer) {
    return buffer.slice(4, 16).toString('hex').toUpperCase();
  }

  // 處理多個封包（分割）
  parseMultipleFrames(buffer) {
    this.bufferCache = Buffer.concat([this.bufferCache, buffer]);
  
    while (this.bufferCache.length > 0) {
      const head = this.bufferCache[0];
  
      // 以下維持既有邏輯，並加 log
      if (head === 0x03) {
        const cid = this.bufferCache[3];
        if (cid === 0x22) {
          const tagCount = this.bufferCache[5];
          let len = 6;
          let offset = 6;
          for (let i = 0; i < tagCount; i++) {
            if (this.bufferCache.length <= offset) break;
            const epcLen = this.bufferCache[offset];
            len += 1 + epcLen;
            offset += 1 + epcLen;
          }
          const frame = this.bufferCache.slice(0, len);
          this.parseResponse(frame);
          this.bufferCache = this.bufferCache.slice(len);
        }
        else {
          // 其他 0x03 封包，假設固定長度 8 bytes（你可以根據協議調整）
          if (this.bufferCache.length < 8) break;
  
          const frame = this.bufferCache.slice(0, 8);
          this.parseResponse(frame);
          this.bufferCache = this.bufferCache.slice(8);
        }
      }
      else if (head === 0x11) {
        if (this.bufferCache.length < 18) break;
        const frame = this.bufferCache.slice(0, 18);
        this.parseResponse(frame);
        this.bufferCache = this.bufferCache.slice(18);
      }
      else {
        // 不明封包，丟棄第一 byte
        this.bufferCache = this.bufferCache.slice(1);
      }
    }
  }  

  // 處理單一封包回應
  parseResponse(buffer) {
    if (buffer.length < 6) return;

    const head = buffer[0];
    const cid = buffer[3];
    const rtn = buffer[4];

    // 主動回報封包處理
    if (buffer.length >= 18 && head === 0x11) {
      if (!this.activeTagDisplay) return;
      const epc = this.getEPCFromBuffer(buffer);
      console.log(`[主動標籤回報]\n  ▸ 原始封包: ${buffer.toString('hex').toUpperCase()}\n  ▸ EPC: ${epc}\n`);
      return;
    }

    // 取得功率回應
    if (head === 0x03 && cid === 0x51 && rtn === 0x00 && buffer.length >= 8) {
      const power = buffer[6];
      if (this._responseResolver) this._responseResolver(power);
      this._responseResolver = null;
      return;
    }

    // 設定功率回應
    if (head === 0x03 && cid === 0x52 && rtn === 0x00) {
      if (this._responseResolver) this._responseResolver();
      this._responseResolver = null;
      return;
    }

    // 查詢參數回應
    if (head === 0x03 && cid === 0x82 && rtn === 0x00) {
      const len = buffer[5];
      const dataField = buffer.slice(6, 6 + len);

      // 若是 setBuzzer/setWorkMode，優先走 callback
      if (this._pendingCallback) {
        this._pendingCallback(dataField);
        this._pendingCallback = null;
        return;
      }

      // 一般參數解析
      const OM = dataField[0];
      const WM = dataField[1];
      const RT = dataField[2];
      const RI = dataField[3];
      const RD = dataField[4];
      const Offset = dataField[5];
      const Interval = dataField[6];
      const Width = dataField[7];
      const Period = dataField[8];
      const SI = (dataField[9] << 8) | dataField[10];
      const BZ = dataField[11];
      const CH = dataField[12];

      const OMDesc = {
        0x00: '232 (BLE/SPP)', 0x01: '485', 0x02: '韋根26', 0x03: '韋根34',
        0x04: '韋根66', 0x05: '韋根98'
      }[OM] || '未知';

      const WMDesc = { 0x00: '命令模式', 0x01: '主動模式', 0x02: '被動模式' }[WM] || '未知';
      const RTDesc = { 0x02: 'EPC', 0x03: 'EPC + OTHER DATA' }[RT] || '未知';
      const buzzerDesc = BZ === 0x00 ? '關閉' : BZ === 0x01 ? '開啟' : `保留值(${BZ})`;

      let rfFreq = '未知頻率', region = '未知區域';
      if (CH >= 0 && CH <= 49) {
        const freq = 920.125 + CH * 0.25;
        rfFreq = `${freq.toFixed(3)} MHz`;
        if (freq >= 920 && freq <= 928) region = '台灣/美國';
        else if (freq >= 865 && freq <= 868) region = '歐洲';
        else if (freq >= 952 && freq <= 954) region = '日本';
      }

      const params = {
        OM, WM, RT, RI, RD, Offset, Interval, Width, Period, SI, BZ, CH,
        OMDesc, WMDesc, RTDesc, buzzerDesc, rfFreq, region
      };

      if (this._responseResolver) this._responseResolver(params);
      this._responseResolver = null;
    }

    // inventoryOnce 回應
    if (head === 0x03 && cid === 0x22 && rtn === 0x00) {
      const tagCount = buffer[5];
      const epcList = [];
      let offset = 6;
      for (let i = 0; i < tagCount; i++) {
        const epcLen = buffer[offset];
        const epc = buffer.slice(offset + 1, offset + 1 + epcLen).toString('hex').toUpperCase();
        epcList.push(epc);
        offset += 1 + epcLen;
      }
      if (this._responseResolver) this._responseResolver(epcList);
      this._responseResolver = null;
      return;
    }
  }
}

export default rd2;
