// powerControl.js

// 建立設定功率封包
function buildSetPowerFrame(power) {
  const frame = Buffer.from([
    0x02,          // 封包起始標記
    0xFF, 0xFF,    // 廠商識別碼或保留
    0x52, 0x00,    // 命令碼 (0x52 代表設定功率)
    0x01,          // 資料長度 (1 byte)
    power          // 功率值 (5~30 dBm)
  ]);
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i];    // 計算所有 byte 總和
  }
  // 計算 checksum，採用補碼 (two's complement)
  const checksum = ((~sum + 1) & 0xFF);
  // 將 checksum 附加在封包尾端並回傳整個 Buffer
  return Buffer.concat([frame, Buffer.from([checksum])]);
}

// 建立查詢功率封包
function buildGetPowerFrame() {
  const frame = Buffer.from([
    0x02,        // 封包起始標記
    0xFF, 0xFF,  // 廠商識別碼或保留
    0x51, 0x00,  // 命令碼 (0x51 查詢功率)
    0x00         // 資料長度 (0 byte)
  ]);
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i];
  }
  // 計算 checksum (補碼)
  const checksum = ((~sum + 1) & 0xFF);
  return Buffer.concat([frame, Buffer.from([checksum])]);
}

// 解析功率回應
function parsePrivatePowerResponse(buffer) {
  const hex = buffer.toString('hex').toUpperCase();
  if (buffer.length >= 7 && buffer[3] === 0x51 && buffer[4] === 0x00) {
    const power = buffer[6];
    console.log(`✅ 成功解析：功率為 ${power} dBm`);
  } else {
    console.warn('⚠️ 回應格式不符:', hex);
  }
}

// 導出模組
module.exports = {
  buildSetPowerFrame,
  buildGetPowerFrame,
  parsePrivatePowerResponse
};
