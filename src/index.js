import express from 'express';
import cors from 'cors';
import rd2 from './model/rd2.js';

const app = express();
app.use(cors());// 允許跨來源請求
app.use(express.json());// 解析 JSON 請求主體

const PORT = 3000;
const reader = new rd2('COM4');

let isTagDisplayEnabled = false;

(async () => {
  try {
    await reader.open();
    console.log('串口已打開');
  } catch (e) {
    console.error('串口打開失敗:', e.message);
    process.exit(1);// 開啟失敗則結束程式
  }
})();

// 非同步錯誤包裝器，簡化 express route 的錯誤處理
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// 啟用主動標籤回報（主動推送讀取到的標籤）
app.post('/enableTagDisplay', asyncHandler(async (req, res) => {
  const params = await reader.queryBasicParams();
  if (params.WM !== 1) {
    return res.status(400).json({
      success: false,
      message: '請先將設備設定為「主動模式」（mode = 1）才能啟用主動標籤回報',
    });
  }

  reader.enableTagDisplay();
  isTagDisplayEnabled = true;
  console.log('主動標籤回報已啟用');
  res.json({ success: true });
}));

// 停用主動標籤回報
app.post('/disableTagDisplay', asyncHandler(async (req, res) => {
  const params = await reader.queryBasicParams();
  if (params.WM !== 1) {
    return res.status(400).json({
      success: false,
      message: '設備目前不是主動模式，無需停用主動標籤回報',
    });
  }

  if (!isTagDisplayEnabled) {
    return res.status(400).json({
      success: false,
      message: '尚未啟用主動標籤回報，無法執行停用',
    });
  }

  reader.disableTagDisplay();
  isTagDisplayEnabled = false;
  console.log('主動標籤回報已停用');
  res.json({ success: true });
}));

// 取得目前功率（非同步）
app.get('/getPower', asyncHandler(async (req, res) => {
  const power = await reader.getPower();
  console.log(`目前功率為 ${power} dBm`);
  res.json({ success: true, power });
}));

// 設定功率，必須介於 5~33 之間，錯誤回應 400
app.post('/setPower', asyncHandler(async (req, res) => {
  const power = req.body ? req.body.power : undefined;
  if (typeof power !== 'number' || power < 5 || power > 33) {
    return res.status(400).json({ success: false, message: '功率需為 5~33 之間' });
  }
  await reader.setPower(power);
  console.log(`功率已設定為 ${power} dBm`);
  res.json({ success: true, message: `已設定為 ${power} dBm` });
}));

// 查詢基本參數
app.get('/queryBasicParams', asyncHandler(async (req, res) => {
  const params = await reader.queryBasicParams();
  const power = await reader.getPower();
  console.log('目前基本參數（摘要）：');
  console.log(`通訊模式：${params.OMDesc}`);
  console.log(`工作模式：${params.WMDesc}`);
  console.log(`標籤讀取類型：${params.RTDesc}`);
  console.log(`數據輸出間隔 RI: ${params.RI}*10 ms`);
  console.log(`單標籤過濾時間 RD: ${params.RD}*0.5s`);
  console.log(`輸出起始位元組: ${params.Offset}`);
  console.log(`脈衝寬度: ${params.Width}*10 μs`);
  console.log(`脈衝週期: ${params.Period}*100 μs`);
  console.log(`蜂鳴器：${params.buzzerDesc}`);
  console.log(`頻率通道：CH ${params.CH} → ${params.rfFreq} (${params.region})`);
  res.json({ success: true, params: { ...params, power } });
}));

// 設定蜂鳴器狀態 (on: true/false)
app.post('/setBuzzer', asyncHandler(async (req, res) => {
  const on = req.body ? req.body.on : undefined;
  if (typeof on !== 'boolean') {
    return res.status(400).json({ success: false, message: 'on 應為 true/false' });
  }
  await reader.setBuzzer(on);
  console.log(`蜂鳴器已${on ? '開啟' : '關閉'}`);
  res.json({ success: true, message: `蜂鳴器已${on ? '開啟' : '關閉'}` });
}));

// 設定工作模式，mode 僅可為 0（命令模式）、1（主動模式）、2（被動模式）
app.post('/setWorkMode', asyncHandler(async (req, res) => {
  const mode = req.body ? req.body.mode : undefined;
  const modeMap = {
    0: '命令模式',
    1: '主動模式',
    2: '被動模式',
  };
  if (![0, 1, 2].includes(mode)) {
    return res.status(400).json({ success: false, message: 'mode 僅可為 0、1、2' });
  }
  await reader.setWorkMode(mode);
  console.log(`工作模式已設定為 ${modeMap[mode]} (${mode})`);
  res.json({ success: true, message: `工作模式設為 ${mode}` });
}));

// 重啟設備
app.post('/rebootDevice', asyncHandler(async (req, res) => {
  await reader.rebootDevice();
  console.log('重啟');
  res.json({ success: true, message: '設備已重新啟動' });
}));

// 還原出廠設定
app.post('/restoreFactorySettings', asyncHandler(async (req, res) => {
  await reader.restoreFactorySettings();
  console.log('還原出廠設定需要執行重啟');
  res.json({ success: true, message: '設備已還原出廠設定' });
}));

app.post('/inventoryOnce', asyncHandler(async (req, res) => {
  console.log('收到 /inventoryOnce 請求');
  try {
    const epcList = await reader.inventoryOnce();
    console.log('讀到 EPC:', epcList);
    res.json({ success: true, epcList });
  } catch (error) {
    console.error('inventoryOnce 發生錯誤:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}));

app.use((err, req, res, next) => {
  console.error('全局錯誤:', err);
  res.status(500).json({ success: false, message: err.message || '伺服器錯誤' });
});

app.listen(PORT, () => {
  console.log(`伺服器已啟動，監聽埠號 ${PORT}`);
});
