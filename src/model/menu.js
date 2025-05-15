const readline = require('readline');

// 建立 readline 介面，接收標準輸入和輸出，並設定提示字串
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '請輸入代號: ',
});

// 印出選單內容的函式，顯示功能選項給使用者看
function printMenu() {
  console.log('\n============================');
  console.log('📡 RFID 設備設定工具');
  console.log('============================');
  console.log('1️⃣ 設定發射功率');
  console.log('2️⃣ 查詢目前功率');
  console.log('0️⃣ 離開程式');
  console.log('============================');
  rl.prompt();
}

//readline 的 question 方法，改用 Promise，方便 async/await 使用
function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// 封裝關閉 readline 介面
function close() {
  rl.close();
}

// 匯出 readline 物件和包裝過的函式
module.exports = {
  rl,
  printMenu,
  question,
  close,
};
