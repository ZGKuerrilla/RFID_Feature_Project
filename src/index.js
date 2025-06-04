import express from 'express';
import cors from 'cors';
import rd2 from './model/rd2.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
let reader = null;

process.on('uncaughtException', (err) => {
  console.error('未捕捉的例外:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('未處理的 Promise 拒絕:', reason);
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.post(
  '/openPort',
  asyncHandler(async (req, res) => {
    const portPath = req.body?.port || 'COM4';
    const baudRate = req.body?.baudRate || 57600;

    if (reader && reader.port?.isOpen) {
      return res.json({ success: true, message: '串口已經開啟' });
    }

    reader = new rd2(portPath, baudRate);
    await reader.open();

    console.log(`✅ 串口已成功開啟 (${portPath} @ ${baudRate}bps)`);

    reader.on('tag', ({ epc }) => {
      console.log(`[標籤事件] EPC: ${epc}`);
    });

    res.json({ success: true, message: '串口已成功開啟' });
  }),
);

app.post(
  '/closePort',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port?.isOpen) {
      return res.status(400).json({ success: false, message: '串口尚未開啟' });
    }

    await reader.close();
    console.log(`串口已關閉 (${reader.port.path})`);
    reader = null;

    res.json({ success: true, message: '串口已關閉' });
  }),
);

app.post(
  '/enableTagDisplay',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    reader.enableTagDisplay();
    console.log('主動標籤回報已啟用');
    res.json({ success: true });
  }),
);

app.post(
  '/disableTagDisplay',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    reader.disableTagDisplay();
    console.log('主動標籤回報已停用');
    res.json({ success: true });
  }),
);

app.get(
  '/getPower',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    const power = await reader.getPower();
    console.log(`目前功率為 ${power} dBm`);
    res.json({ success: true, power });
  }),
);

app.post(
  '/setPower',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    const power = req.body ? req.body.power : undefined;
    if (typeof power !== 'number' || power < 5 || power > 33) {
      return res.status(400).json({ success: false, message: '功率需為 5~33 之間' });
    }
    await reader.setPower(power);
    console.log(`功率已設定為 ${power} dBm`);
    res.json({ success: true, message: `已設定為 ${power} dBm` });
  }),
);

app.get(
  '/queryBasicParams',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    const params = await reader.queryBasicParams();
    const power = await reader.getPower();
    console.log('目前基本參數（摘要）：');
    console.log(`通訊模式：${params.OMDesc}`);
    console.log(`工作模式：${params.WMDesc}`);
    console.log(`標籤讀取類型：${params.RTDesc}`);
    console.log(`數據輸出間隔 RI: ${params.RI}*10 ms`);
    console.log(`單標籤過濾時間 RD: ${params.RD}*0.5s`);
    console.log(`輸出起始位元組: ${params.Offset}`);
    console.log(`蜂鳴器：${params.buzzerDesc}`);
    console.log(`頻率通道：CH ${params.CH} → ${params.rfFreq} (${params.region})`);
    res.json({ success: true, params: { ...params, power } });
  }),
);

app.post(
  '/setBuzzer',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    const on = req.body ? req.body.on : undefined;
    if (typeof on !== 'boolean') {
      return res.status(400).json({ success: false, message: 'on 應為 true/false' });
    }
    await reader.setBuzzer(on);
    console.log(`蜂鳴器已${on ? '開啟' : '關閉'}`);
    res.json({ success: true, message: `蜂鳴器已${on ? '開啟' : '關閉'}` });
  }),
);

app.post(
  '/setWorkMode',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    const mode = req.body ? req.body.mode : undefined;
    const modeMap = { 0: '命令模式', 1: '主動模式', 2: '被動模式' };
    if (![0, 1, 2].includes(mode)) {
      return res.status(400).json({ success: false, message: 'mode 僅可為 0、1、2' });
    }
    await reader.setWorkMode(mode);
    console.log(`工作模式已設定為 ${modeMap[mode]} (${mode})`);
    res.json({ success: true, message: `工作模式設為 ${mode}` });
  }),
);

app.post(
  '/restoreAndReboot',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }

    await reader.restoreFactorySettings();
    console.log('恢復出廠設定完成');

    await reader.rebootDevice();
    console.log('設備已重啟');

    res.json({ success: true, message: '設備恢復出廠並已重啟' });
  }),
);

// ✅ 新增 /getSeenTags API
app.get(
  '/getSeenTags',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    const tags = reader.getSeenEPCs();
    res.json({ success: true, tags });
  }),
);

// 新增一個路由清除已記錄的 EPC 清單
app.post('/clearEPCs', (req, res) => {
  try {
    reader.clearSeenEPCs();
    res.json({ success: true, message: '已清除 EPC 清單' });
  } catch (error) {
    res.status(500).json({ success: false, message: '清除 EPC 清單失敗', error: error.message });
  }
});

app.get(
  '/readEPCOnce',
  asyncHandler(async (req, res) => {
    if (!reader || !reader.port.isOpen) {
      return res.status(400).json({ success: false, message: '尚未開啟串口' });
    }
    try {
      const result = await reader.readSingleEPC();
      res.json({ success: true, epc: result.epc });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }),
);

// 全局錯誤中介軟體
app.use((err, req, res, next) => {
  console.error('全局錯誤:', err);
  res.status(500).json({ success: false, error: err.message || '未知錯誤' });
});

app.listen(PORT, () => {
  console.log(`伺服器已啟動，監聽埠號 ${PORT}`);
});
