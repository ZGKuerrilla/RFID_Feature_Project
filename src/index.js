import {} from './model/rd2.js'

const { SerialPort } = require('serialport');
const { buildSetPowerFrame, buildGetPowerFrame, parsePrivatePowerResponse } = require('./powerControl');//引入設定功率模組 
const menu = require('./menu');//引入選單模組 

let bufferCache = Buffer.alloc(0);//資料緩衝區，確保封包讀取
let waitingForResponse = false;//避免重複發送命令
let responseResolver = null;
let responseTimeout = null;//指令超時判斷

//初始設定
const serialPort = new SerialPort({
  path: 'COM4',  // PC接口
  baudRate: 57600,
  parity: 'none',
  dataBits: 8,
  stopBits: 1,
  autoOpen: false,
});

//清楚等待回應的狀態
function clearResponseWait() {
  waitingForResponse = false;
  if (responseResolver) {
    responseResolver();
    responseResolver = null;
  }
  if (responseTimeout) {
    clearTimeout(responseTimeout);
    responseTimeout = null;
  }
}

//設定10秒，避免程式等待，造成程式卡住
function waitForResponse() {
  waitingForResponse = true;
  return new Promise((resolve, reject) => {
    responseResolver = resolve;
    responseTimeout = setTimeout(() => {
      if (waitingForResponse) {
        waitingForResponse = false;
        responseResolver = null;
        reject(new Error('設備回應超時'));
      }
    }, 10000);
  });
}

async function writeCommand(cmd) {
  return new Promise((resolve, reject) => {
    serialPort.write(cmd, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

//設定功率命令封包並送出
async function setPower(power) {
  const cmd = buildSetPowerFrame(power);
  await writeCommand(cmd);
  console.log(`📤 已送出設定功率指令 (${power} dBm):`, cmd.toString('hex').toUpperCase());

  await waitForResponse();
  menu.printMenu();
}

//查詢目前功率命令封包並送出
async function getPower() {
  const cmd = buildGetPowerFrame();
  await writeCommand(cmd);
  console.log('📤 已送出查詢功率指令:', cmd.toString('hex').toUpperCase());

  await waitForResponse();
  menu.printMenu();
}

//提示功率範圍
async function promptPower() {
  while (true) {
    const input = await menu.question('請 KEY 功率 (5~30 dBm): ');
    const power = Number(input);
    if (isNaN(power) || power < 5 || power > 30) {
      console.log('❌ 功率輸入錯了，請重新輸入');
      continue;
    }
    return power;
  }
}

//監聽收到資料
serialPort.on('data', (data) => {
  //console.log('🔵 收到資料:', data.toString('hex').toUpperCase()); //確認收到資料

  bufferCache = Buffer.concat([bufferCache, data]);
  //將資料放入緩衝區，依照封包格式逐筆解
  while (bufferCache.length >= 7) {
    if (bufferCache[0] !== 0x03) {
      bufferCache = bufferCache.slice(1);
      continue;
    }
    const packet = bufferCache.slice(0, 7);
    bufferCache = bufferCache.slice(7);

    if (packet[3] === 0x51 && packet[4] === 0x00) {  //0x51 0x00：解析查詢功率回應
      parsePrivatePowerResponse(packet);
      clearResponseWait();
    } else if (packet[3] === 0x52 && packet[4] === 0x00) {  //0x52 0x00：設定功率成功的回應
      console.log('✅ 設定功率成功');
      clearResponseWait();
    } else {
      console.warn('⚠️ 未知回應:', packet.toString('hex').toUpperCase());
      clearResponseWait();
    }
  }
});

//監聽使用者 CLI 輸入的選項
menu.rl.on('line', async (line) => {
  const input = line.trim();

  if (waitingForResponse) {
    console.log('⏳ 烏龜爬行中請稍等...');
    return;
  }

  if (input === '1') {
    try {
      const power = await promptPower();
      await setPower(power);
    } catch (err) {
      console.log('❌ 設定功率失敗:', err.message);
      menu.printMenu();
    }
  } else if (input === '2') {
    try {
      await getPower();
    } catch (err) {
      console.log('❌ 查詢功率失敗:', err.message);
      menu.printMenu();
    }
  } else if (input === '0') {
    console.log('👋 關機下班，Bye!');
    serialPort.close(() => {
      menu.close();
      process.exit(0);
    });
  } else {
    console.log('❌ KEY錯了，再打一次');
    menu.printMenu();
  }
});

serialPort.open((err) => {
  if (err) {
    console.error('❌ 串口開啟失敗:', err.message);
    process.exit(1);
  }
  console.log('✅ 串口已開啟');
  menu.printMenu();
});


