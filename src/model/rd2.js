// src/model/rd2.js

import { SerialPort } from "serialport";
import { EventEmitter } from "events";

class rd2 extends EventEmitter {
  /**
   * @param {string} portPath Serial Port，例如 COM4
   * @param {number} baudRate Baud Rate，預設 57600
   */
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

    /**
     * 已讀取過的 EPC
     */
    this.seenEPCs = new Set();

    /**
     * 是否處理 Reader 主動回報的 Tag
     */
    this.activeTagDisplay = false;

    /**
     * 單次 EPC 讀取使用
     */
    this._responseBuffer = [];
    this._isReadingSingleEPC = false;
    this._timeoutId = null;

    /**
     * Serial Port Data Event
     */
    this.port.on("data", (data) => {
      this.handleIncomingData(data);
    });

    /**
     * Serial Port Error Event
     */
    this.port.on("error", (error) => {
      console.error("[SerialPort Error]", error.message);

      this.emit("error", error);
    });
  }

  /**
   * 處理 Reader 傳回的 Serial Data
   */
  handleIncomingData(data) {
    if (!Buffer.isBuffer(data) || data.length === 0) {
      return;
    }

    /**
     * 單次盤點期間先收集完整資料
     */
    if (this._isReadingSingleEPC) {
      this._responseBuffer.push(data);
      return;
    }

    /**
     * 主動模式 Tag Display
     *
     * 目前依 RD2 實際回傳格式：
     * data[0] === 0x11
     * EPC 位於 byte 4 ~ 15，共 12 bytes
     */
    if (this.activeTagDisplay && data[0] === 0x11 && data.length >= 16) {
      const epc = data.slice(4, 16).toString("hex").toUpperCase();

      if (!epc) {
        return;
      }

      this.seenEPCs.add(epc);

      this.emit("tag", {
        epc,
        raw: data,
      });
    }
  }

  /**
   * 開啟 Serial Port
   */
  open() {
    return new Promise((resolve, reject) => {
      if (this.port.isOpen) {
        resolve();
        return;
      }

      this.port.open((error) => {
        if (error) {
          reject(new Error(`開啟 Serial Port 失敗: ${error.message}`));
          return;
        }

        resolve();
      });
    });
  }

  /**
   * 關閉 Serial Port
   */
  close() {
    return new Promise((resolve, reject) => {
      if (!this.port?.isOpen) {
        resolve();
        return;
      }

      this.port.close((error) => {
        if (error) {
          reject(new Error(`關閉 Serial Port 失敗: ${error.message}`));
          return;
        }

        resolve();
      });
    });
  }

  /**
   * 確認 Serial Port 已開啟
   */
  ensurePortOpen() {
    if (!this.port?.isOpen) {
      throw new Error("Serial Port 尚未開啟");
    }
  }

  /**
   * 發送資料至 RD2
   */
  send(buffer) {
    return new Promise((resolve, reject) => {
      try {
        this.ensurePortOpen();
      } catch (error) {
        reject(error);
        return;
      }

      this.port.write(buffer, (error) => {
        if (error) {
          reject(new Error(`發送資料失敗: ${error.message}`));
          return;
        }

        /**
         * 等待 OS 將資料實際送出
         */
        this.port.drain((drainError) => {
          if (drainError) {
            reject(new Error(`Serial Port drain 失敗: ${drainError.message}`));
            return;
          }

          resolve();
        });
      });
    });
  }

  /**
   * 計算 RD2 Checksum
   *
   * Two's complement：
   * checksum = (~sum + 1) & 0xFF
   */
  calcChecksum(buffer) {
    const sum = buffer.reduce((accumulator, byte) => accumulator + byte, 0);

    return (~sum + 1) & 0xff;
  }

  /**
   * 將 Command Body 包裝成 RD2 Command Frame
   */
  wrapCmd(body) {
    if (!Array.isArray(body)) {
      throw new TypeError("Command body 必須為 Array");
    }

    const base = Buffer.from([0x02, 0xff, 0xff, ...body]);

    const checksum = this.calcChecksum(base);

    return Buffer.concat([base, Buffer.from([checksum])]);
  }

  /**
   * 等待下一筆 Serial Response
   */
  waitForResponse(timeoutMs = 500) {
    return new Promise((resolve, reject) => {
      let timer = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }

        this.port.removeListener("data", onData);
      };

      const onData = (data) => {
        cleanup();
        resolve(data);
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error("等待 Reader 回應超時"));
      }, timeoutMs);

      this.port.once("data", onData);
    });
  }

  /**
   * 發送 Command 並等待一次 Response
   */
  async sendAndWait(buffer, timeoutMs = 500) {
    const responsePromise = this.waitForResponse(timeoutMs);

    try {
      await this.send(buffer);
    } catch (error) {
      /*
       * waitForResponse 的 once listener 在 write 失敗時
       * 仍會自行 timeout，不影響主流程。
       */
      throw error;
    }

    return responsePromise;
  }

  /**
   * 取得目前已讀取的 EPC
   */
  getSeenEPCs() {
    return Array.from(this.seenEPCs);
  }

  /**
   * 清除已讀取 EPC
   */
  clearSeenEPCs() {
    this.seenEPCs.clear();
  }

  /**
   * 啟用主動 Tag Display
   */
  enableTagDisplay() {
    this.activeTagDisplay = true;
  }

  /**
   * 停用主動 Tag Display
   */
  disableTagDisplay() {
    this.activeTagDisplay = false;
  }

  // ============================================================
  // RD2 Command Frame Builders
  // ============================================================

  /**
   * 查詢發射功率
   */
  buildGetPowerFrame() {
    return this.wrapCmd([0x51, 0x00, 0x00]);
  }

  /**
   * 設定發射功率
   */
  buildSetPowerFrame(power) {
    return this.wrapCmd([0x52, 0x00, 0x01, power]);
  }

  /**
   * 查詢基本參數
   */
  buildQueryBasicParamsFrame() {
    return this.wrapCmd([0x82, 0x32, 0x00]);
  }

  /**
   * 設定基本參數
   */
  buildSetParamsFrame(dataField) {
    return this.wrapCmd([0x82, 0x31, dataField.length, ...dataField]);
  }

  /**
   * 恢復出廠設定
   */
  buildRestoreFactoryFrame() {
    return this.wrapCmd([0xd4, 0x00, 0x00]);
  }

  /**
   * Reader Reboot
   */
  buildRebootFrame() {
    return this.wrapCmd([0xd1, 0x00, 0x00]);
  }

  /**
   * 單次 RFID Inventory
   */
  buildReadSingleEPCFrame() {
    return this.wrapCmd([0x21, 0x00, 0x00]);
  }

  // ============================================================
  // Reader Operations
  // ============================================================

  /**
   * 查詢 Reader 發射功率
   */
  async getPower() {
    const data = await this.sendAndWait(this.buildGetPowerFrame(), 500);

    if (!data || data.length <= 6) {
      throw new Error("Reader 回傳的功率資料格式不完整");
    }

    return data[6];
  }

  /**
   * 設定 Reader 發射功率
   */
  async setPower(power) {
    if (!Number.isInteger(power) || power < 5 || power > 33) {
      throw new RangeError("RFID 發射功率必須為 5~33 之間的整數");
    }

    await this.sendAndWait(this.buildSetPowerFrame(power), 500);
  }

  /**
   * 查詢 Reader 基本參數
   */
  async queryBasicParams() {
    const data = await this.sendAndWait(this.buildQueryBasicParamsFrame(), 500);

    if (!data || data.length < 6) {
      throw new Error("Reader 回傳的基本參數格式不完整");
    }

    const len = data[5];

    if (data.length < 6 + len) {
      throw new Error("Reader 回傳的基本參數長度不正確");
    }

    const d = data.slice(6, 6 + len);

    /**
     * 目前基本參數至少需要 13 bytes
     */
    if (d.length < 13) {
      throw new Error("Reader 基本參數資料不足");
    }

    const OM = d[0];
    const WM = d[1];
    const RT = d[2];
    const BZ = d[11];
    const CH = d[12];

    const communicationModeMap = {
      0x00: "232 (BLE/SPP)",
      0x01: "485",
      0x02: "韋根26",
      0x03: "韋根34",
      0x04: "韋根66",
      0x05: "韋根98",
    };

    const workModeMap = {
      0x00: "命令模式",
      0x01: "主動模式",
      0x02: "被動模式",
    };

    const readTypeMap = {
      0x02: "僅 EPC",
      0x03: "EPC + 擴展資料",
    };

    const OMDesc = communicationModeMap[OM] ?? `未知 (${OM})`;

    const WMDesc = workModeMap[WM] ?? `未知 (${WM})`;

    const RTDesc = readTypeMap[RT] ?? `未知 (${RT})`;

    const buzzerDesc = BZ === 0x00 ? "關閉" : BZ === 0x01 ? "開啟" : `保留值 (${BZ})`;

    /**
     * RF Channel
     *
     * 保留目前專案原本使用的 RD2 Channel 計算方式。
     */
    let rfFreq = "未知";
    let region = "未知";

    if (CH >= 0 && CH <= 49) {
      const frequency = 920.125 + CH * 0.25;

      rfFreq = `${frequency.toFixed(3)} MHz`;

      if (frequency >= 920 && frequency <= 928) {
        region = "台灣/美國";
      } else if (frequency >= 865 && frequency <= 868) {
        region = "歐洲";
      } else if (frequency >= 952 && frequency <= 954) {
        region = "日本";
      }
    }

    return {
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
      WMDesc,
      RTDesc,
      buzzerDesc,
      rfFreq,
      region,
    };
  }

  /**
   * 設定蜂鳴器
   */
  async setBuzzer(on) {
    if (typeof on !== "boolean") {
      throw new TypeError("Buzzer 狀態必須為 true 或 false");
    }

    /**
     * 先取得目前設定，
     * 避免修改 Buzzer 時覆蓋其他 Reader 參數。
     */
    const data = await this.sendAndWait(this.buildQueryBasicParamsFrame(), 500);

    if (!data || data.length < 6) {
      throw new Error("Reader 回傳參數格式不完整");
    }

    const len = data[5];

    if (data.length < 6 + len) {
      throw new Error("Reader 回傳參數長度不正確");
    }

    const field = Buffer.from(data.slice(6, 6 + len));

    if (field.length <= 11) {
      throw new Error("Reader 回傳參數缺少 Buzzer 欄位");
    }

    field[11] = on ? 0x01 : 0x00;

    await this.sendAndWait(this.buildSetParamsFrame(field), 500);
  }

  /**
   * 設定 Reader 工作模式
   *
   * 0 = 命令模式
   * 1 = 主動模式
   * 2 = 被動模式
   */
  async setWorkMode(mode) {
    if (![0, 1, 2].includes(mode)) {
      throw new RangeError("工作模式僅可為 0、1、2");
    }

    /**
     * 先讀取目前設定，
     * 再只修改 Work Mode 欄位。
     */
    const data = await this.sendAndWait(this.buildQueryBasicParamsFrame(), 500);

    if (!data || data.length < 6) {
      throw new Error("Reader 回傳參數格式不完整");
    }

    const len = data[5];

    if (data.length < 6 + len) {
      throw new Error("Reader 回傳參數長度不正確");
    }

    const field = Buffer.from(data.slice(6, 6 + len));

    if (field.length <= 1) {
      throw new Error("Reader 回傳參數缺少 Work Mode 欄位");
    }

    field[1] = mode;

    await this.sendAndWait(this.buildSetParamsFrame(field), 500);
  }

  /**
   * Reader Reboot
   */
  async rebootDevice() {
    await this.sendAndWait(this.buildRebootFrame(), 1000);
  }

  /**
   * 恢復 Reader 出廠設定
   */
  async restoreFactorySettings() {
    await this.sendAndWait(this.buildRestoreFactoryFrame(), 1000);
  }

  /**
   * 單次讀取 EPC
   *
   * RD2 單次盤點可能分成多個 Serial Data Chunk，
   * 因此先收集 Response，再從完整 Buffer 中解析 EPC。
   *
   * 目前依實機測試使用 0xE2 作為 EPC 起始判斷，
   * 並讀取 12 bytes EPC。
   */
  async readSingleEPC(timeoutMs = 500) {
    if (this._isReadingSingleEPC) {
      throw new Error("目前已有 EPC 讀取作業進行中");
    }

    this.ensurePortOpen();

    this._responseBuffer = [];
    this._isReadingSingleEPC = true;

    try {
      await this.send(this.buildReadSingleEPCFrame());

      return await new Promise((resolve, reject) => {
        this._timeoutId = setTimeout(() => {
          try {
            const full = Buffer.concat(this._responseBuffer);

            if (full.length === 0) {
              reject(new Error("讀取 EPC 超時，Reader 未回傳資料"));
              return;
            }

            console.log("[Reader Response]", full.toString("hex").toUpperCase());

            /**
             * 目前依實機資料：
             *
             * EPC 常見開頭為 E2，
             * 並使用 96-bit / 12-byte EPC。
             */
            const epcStartIndex = full.indexOf(0xe2);

            const EPC_LENGTH = 12;

            if (epcStartIndex === -1 || full.length < epcStartIndex + EPC_LENGTH) {
              reject(new Error("Reader 有回傳資料，但未擷取到有效 EPC"));
              return;
            }

            const epc = full
              .slice(epcStartIndex, epcStartIndex + EPC_LENGTH)
              .toString("hex")
              .toUpperCase();

            console.log("[EPC]", epc);

            resolve({
              epc,
            });
          } catch (error) {
            reject(error);
          }
        }, timeoutMs);
      });
    } finally {
      if (this._timeoutId) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
      }

      this._responseBuffer = [];
      this._isReadingSingleEPC = false;
    }
  }
}

export default rd2;
