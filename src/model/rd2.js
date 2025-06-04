// model/rd2.js
import { SerialPort } from "serialport";
import { EventEmitter } from "events";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class rd2 extends EventEmitter {
  constructor(portPath, baudRate = 57600) {
    super();

    this.port = new SerialPort({
      path: portPath,
      baudRate,
      parity: "none",
      dataBits: 8,
      stopBits: 1,
      autoOpen: false,
    });

    this.seenEPCs = new Set();
    this.activeTagDisplay = false;

    this._responseBuffer = [];
    this._resolveRead = null;
    this._timeoutId = null;

    this.port.on("data", (data) => {
      if (this._resolveRead) {
        this._responseBuffer.push(data);
      } else if (this.activeTagDisplay && data[0] === 0x11 && data.length >= 18) {
        const epc = data.slice(4, 16).toString("hex").toUpperCase();
        this.seenEPCs.add(epc);
        this.emit("tag", { epc, raw: data });
      }
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      if (this.port && this.port.isOpen) {
        this.port.close((err) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });
  }

  send(buffer) {
    this.port.write(buffer, (err) => {
      if (err) console.error("發送資料失敗:", err.message);
    });
  }

  wrapCmd(body) {
    const base = [0x02, 0xff, 0xff, ...body];
    const checksum = this.calcChecksum(Buffer.from(base));
    return Buffer.concat([Buffer.from(base), Buffer.from([checksum])]);
  }

  calcChecksum(buffer) {
    const sum = buffer.reduce((acc, b) => acc + b, 0);
    return (~sum + 1) & 0xff;
  }

  getSeenEPCs() {
    return Array.from(this.seenEPCs);
  }

  clearSeenEPCs() {
    this.seenEPCs.clear();
  }

  enableTagDisplay() {
    this.activeTagDisplay = true;
  }

  disableTagDisplay() {
    this.activeTagDisplay = false;
  }

  buildGetPowerFrame() {
    return this.wrapCmd([0x51, 0x00, 0x00]);
  }

  buildSetPowerFrame(power) {
    return this.wrapCmd([0x52, 0x00, 0x01, power]);
  }

  buildQueryBasicParamsFrame() {
    return this.wrapCmd([0x82, 0x32, 0x00]);
  }

  buildSetParamsFrame(dataField) {
    return this.wrapCmd([0x82, 0x31, dataField.length, ...dataField]);
  }

  buildRestoreFactoryFrame() {
    return this.wrapCmd([0xd4, 0x00, 0x00]);
  }

  buildRebootFrame() {
    return this.wrapCmd([0xd1, 0x00, 0x00]);
  }

  async getPower() {
    return new Promise((resolve, reject) => {
      let timeout = setTimeout(() => reject(new Error("查詢功率超時")), 500);
      this.port.once("data", (data) => {
        clearTimeout(timeout);
        resolve(data[6]);
      });
      this.send(this.buildGetPowerFrame());
    });
  }

  async setPower(power) {
    return new Promise((resolve, reject) => {
      let timeout = setTimeout(() => reject(new Error("設定功率超時")), 500);
      this.port.once("data", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.send(this.buildSetPowerFrame(power));
    });
  }

  async queryBasicParams() {
    return new Promise((resolve, reject) => {
      let timeout = setTimeout(() => reject(new Error("查詢參數超時")), 500);
      this.port.once("data", (data) => {
        clearTimeout(timeout);
        const len = data[5];
        const d = data.slice(6, 6 + len);

        const OM = d[0];
        const WM = d[1];
        const RT = d[2];
        const BZ = d[11];
        const CH = d[12];

        // OM (通訊模式)
        const OMDesc =
          {
            0x00: "232 (BLE/SPP)",
            0x01: "485",
            0x02: "韋根26",
            0x03: "韋根34",
            0x04: "韋根66",
            0x05: "韋根98",
          }[OM] || `未知 (${OM})`;

        // RT (標籤讀取類型)
        const RTDesc =
          {
            0x02: "僅 EPC",
            0x03: "EPC + 擴展資料",
          }[RT] || `未知 (${RT})`;

        // 頻率與區域描述
        let rfFreq = "未知";
        let region = "未知";
        if (CH >= 0 && CH <= 49) {
          const freq = 920.125 + CH * 0.25;
          rfFreq = `${freq.toFixed(3)} MHz`;
          if (freq >= 920 && freq <= 928) region = "台灣/美國";
          else if (freq >= 865 && freq <= 868) region = "歐洲";
          else if (freq >= 952 && freq <= 954) region = "日本";
        }

        resolve({
          OM,
          WM,
          RT,
          RI: d[3],
          RD: d[4],
          Offset: d[5],
          Interval: d[6],
          Width: d[7],
          Period: d[8],
          SI: (d[9] << 8) | d[10],
          BZ,
          CH,
          OMDesc,
          WMDesc: { 0: "命令模式", 1: "主動模式", 2: "被動模式" }[WM] || `未知 (${WM})`,
          RTDesc,
          buzzerDesc: BZ === 0x00 ? "關閉" : BZ === 0x01 ? "開啟" : `保留值 (${BZ})`,
          rfFreq,
          region,
        });
      });
      this.send(this.buildQueryBasicParamsFrame());
    });
  }

  async setBuzzer(on) {
    return new Promise((resolve, reject) => {
      this.port.once("data", (data) => {
        const len = data[5];
        const field = Buffer.from(data.slice(6, 6 + len));
        field[11] = on ? 0x01 : 0x00;
        this.port.once("data", () => resolve());
        this.send(this.buildSetParamsFrame(field));
      });
      this.send(this.buildQueryBasicParamsFrame());
    });
  }

  async setWorkMode(mode) {
    return new Promise((resolve, reject) => {
      this.port.once("data", (data) => {
        const len = data[5];
        const field = Buffer.from(data.slice(6, 6 + len));
        field[1] = mode;
        this.port.once("data", () => resolve());
        this.send(this.buildSetParamsFrame(field));
      });
      this.send(this.buildQueryBasicParamsFrame());
    });
  }

  async rebootDevice() {
    return new Promise((resolve) => {
      this.port.once("data", () => resolve());
      this.send(this.buildRebootFrame());
    });
  }

  async restoreFactorySettings() {
    return new Promise((resolve) => {
      this.port.once("data", () => resolve());
      this.send(this.buildRestoreFactoryFrame());
    });
  }

  async readSingleEPC(timeoutMs = 500) {
    return new Promise((resolve, reject) => {
      this._responseBuffer = [];
      this._resolveRead = resolve;

      this.send(this.wrapCmd([0x21, 0x00, 0x00]));

      this._timeoutId = setTimeout(() => {
        const full = Buffer.concat(this._responseBuffer);
        console.log("[接收到資料]", full.toString("hex").toUpperCase());

        const idx = full.indexOf(0xe2);
        if (idx !== -1 && full.length >= idx + 12) {
          const epc = full
            .slice(idx, idx + 12)
            .toString("hex")
            .toUpperCase();
          console.log("[成功擷取 EPC]", epc);
          resolve({ epc });
        } else {
          reject(new Error("讀取超時或未擷取到 EPC"));
        }

        this._resolveRead = null;
        clearTimeout(this._timeoutId);
      }, timeoutMs);
    });
  }
}

export default rd2;
