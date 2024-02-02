import { TplFeature, DBItem, CallbackListItem, CallbackSetList, UBrowserWindow } from '@/types/utools';
import FundDBHelper from '@/Helper/FundDBHelper';
import { IFundValuationDetailResult } from '@/model/IFundValuationDetailResult';
import { get } from '@/Helper/HttpHelper';
import { ISearchFundResult } from '@/model/ISearchFundResult';
import { IFundEnt } from '@/model/IFundEnt';
import Mousetrap from '../assets/js/mousetrap.min.js';
import UserAgentHelper from '@/Helper/UserAgentHelper.js';

// 缓存基金详情
let CACHE_FUND_DB_LIST: DBItem<IFundEnt>[];
// 当前搜索关键字
let CURRENT_SEARCH_WORD = '';
let QUERY_TIMER: NodeJS.Timeout;
let CACHE_CALLBACK_SET_LIST: CallbackSetList;

const getMyFundDetails = async () => {
  const dbList = FundDBHelper.getAll();
  await Promise.all(
    dbList.map(async db => {
      try {
        const oldData = db.data;

        const searchFundResultStr = await get(`https://fundgz.1234567.com.cn/js/${oldData.id}.js?rt=${Date.now()}`);
        const searchFundResultMatch = searchFundResultStr.match(/jsonpgz\((.*)\);/);
        if (!searchFundResultMatch) {
          utools.showMessageBox({
            message: '获取基金搜索结果失败',
          });
          return;
        }
        const searchFundResult = JSON.parse(searchFundResultMatch[1]);
        let updateTime = searchFundResult.gztime
        // 简便算法，如果10分钟内没更新，认为已经闭市
        let doneToday = new Date().getTime() - new Date(updateTime).getTime() > 10 * 60 * 1000;
        db.data = {
          ...oldData,
          yesJJJZ: Number(searchFundResult.dwjz || '0'), // 单位净值
          nowJJJZ: Number(searchFundResult.gsz || '0'), // 估算值
          lastTime: updateTime,
          isValuation: !doneToday // nowJJJZ 是否为估值
        };
        FundDBHelper.update(db);
        // console.log(JSON.stringify(db.data));
      } catch (error) {
        console.error(`${db.data.id} ${db.data.name} :`, error);
        // utools.showNotification(`网络请求失败，请稍后再试`);
      }
      return db;
    })
  );
  return FundDBHelper.getAll();
};

const fundDetailsToCbList = (dbList: DBItem<IFundEnt>[], searchWord = '') => {
  let sumIncome = 0;
  let cbList = dbList.map(db => {
    const fund = db.data;
    const rate = fund.yesJJJZ === 0 ? 0 : fund.nowJJJZ / fund.yesJJJZ - 1;
    const income = fund.holdCount > 0 ? rate * fund.holdCount * fund.yesJJJZ : 0;
    sumIncome += Math.round(income * 100) / 100;
    const cb: CallbackListItem = {
      fundCode: fund.id,
      title: `${fund.id} ${fund.name} ${fund.isValuation ? '' : '✅'}`,
      description: `${(rate * 100).toFixed(2)}% ￥${income.toFixed(2)}` + (fund.holdCount > 0 ? ` 持有份额:${fund.holdCount.toFixed(2)}` : ''),
      icon: rate >= 0 ? 'assets/img/up.png' : 'assets/img/down.png',
      searchWord,
    };
    return cb;
  });
  if (cbList.length === 0) {
    cbList = [
      {
        title: ``,
        description: ``,
        icon: 'assets/img/add.png',
        searchWord,
      },
    ];
  } else {
    cbList = [
      {
        title: `今日总收益 ${dbList.filter(x => x.data.holdCount > 0).every(x => !x.data.isValuation) ? '✅' : ''}`,
        description: `￥${sumIncome.toFixed(2)}`,
        icon: sumIncome >= 0 ? 'assets/img/up.png' : 'assets/img/down.png',
        searchWord,
      },
      ...cbList,
    ];
  }
  return cbList;
};

const loading = (cb: CallbackSetList, loadingTips = '加载中，请稍后。。。') => {
  cb([
    {
      title: loadingTips,
      description: '~~~~~~~~~~~~~~~',
      icon: 'assets/img/loading.png',
    },
  ]);
};

const showFundDetails = async (cb: CallbackSetList, isShowLoading = true) => {
  if (isShowLoading) {
    loading(cb);
  }
  const dbList = await getMyFundDetails();
  // 缓存
  CACHE_FUND_DB_LIST = dbList;
  const cbList = fundDetailsToCbList(dbList);
  cb(cbList);
  // 定时展示
  QUERY_TIMER = setTimeout(() => {
    showFundDetails(cb, false);
  }, 1000 * 60);
};

const hanlderUTools = {
  get(obj, prop) {
    // 是否魔改版标识
    if (prop === 'isMagicRevision') {
      return true;
    }
    if (prop === '__event__') {
      const val = obj[prop];
      // 处理用户退出当前插件，停止查询
      if (val.onPluginOut && !val.onPluginOut.isMagicRevision) {
        const rawOnPluginOut = val.onPluginOut;
        val.onPluginOut = cb => {
          console.log(`用户退出插件`);
          clearTimeout(QUERY_TIMER);
          unregisterShortCut();
          return rawOnPluginOut(cb);
        };
        val.onPluginOut.isMagicRevision = true;
      }
      return val;
    }
    return obj[prop];
  },
  // set(obj, prop, value) {
  //   console.log(`set ${prop} : `, value);
  //   obj[prop] = value;
  //   return true;
  // },
};

const registerShortCut = async () => {
  // 删除
  Mousetrap.bind('mod+del', () => {
    const selectedItem = document.querySelector('.list-item-selected .list-item-title');
    if (selectedItem && selectedItem.innerHTML) {
      const fundId = selectedItem.innerHTML.split(' ')[0];
      if (CACHE_FUND_DB_LIST && CACHE_FUND_DB_LIST.length > 0 && CACHE_FUND_DB_LIST.some(x => x.data.id === fundId)) {
        FundDBHelper.del(fundId);
        if (CACHE_CALLBACK_SET_LIST) {
          clearTimeout(QUERY_TIMER);
          showFundDetails(CACHE_CALLBACK_SET_LIST);
        } else {
          console.error(`CACHE_CALLBACK_SET_LIST is null`);
        }
      } else {
        console.error(`del error :`);
        console.error(`fundId : ${fundId} , CACHE_FUND_DB_LIST : `, CACHE_FUND_DB_LIST);
      }
    }
    return false;
  });
  // 跳转新增
  Mousetrap.bind('mod+ins', () => {
    utools.redirect('添加自选基金', '');
  });
};
const unregisterShortCut = async () => {
  // Mousetrap.unbind(['up', 'down', 'mod+del', 'mod+ins']);
};
const showFundDetail = async (fundEnt: Partial<IFundEnt>) => {
  const url = `/assets/html/fundDetail/fundDetail.html?id=${fundEnt.id}`;
  // console.log(`url : `, url);
  // const title = `${fundName}(${fundCode})`;
  const fundDetailUbWindow = utools.createBrowserWindow(
    url,
    {
      // width: 1376,
      // height: 768,
      height: 480,
      // title,
      show: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: 'preload.js',
      },
    },
    () => {
      // 显示
      fundDetailUbWindow.show();
      // 置顶
      // fundDetailUbWindow.setAlwaysOnTop(true);
      // 窗口全屏
      // fundDetailUbWindow.setFullScreen(true);
      // 向子窗口传递数据
      // fundDetailUbWindow.webContents.send('ping');
      // require('electron').ipcRenderer.sendTo(fundDetailUbWindow.webContents.id, 'ping');
      // // 执行脚本
      // fundDetailUbWindow.executeJavaScript('fetch("https://jsonplaceholder.typicode.com/users/1").then(resp => resp.json())').then(result => {
      //   console.log(result); // Will be the JSON object from the fetch call
      // });
    }
  );
  fundDetailUbWindow.webContents.setUserAgent(UserAgentHelper.getRandom());
  // fundDetailUbWindow.webContents.openDevTools();
};

const fundMy: TplFeature = {
  mode: 'list',
  args: {
    placeholder: '输入份额，选择基金，Enter 保存，ctrl + delete 删除 ， ctrl + insert 添加 ，s前缀搜索',
    enter: async (action, callbackSetList) => {
      CACHE_CALLBACK_SET_LIST = callbackSetList;
      if (!utools.isMagicRevision) {
        utools = new Proxy(utools, hanlderUTools);
      }
      clearTimeout(QUERY_TIMER);
      showFundDetails(callbackSetList);
      registerShortCut();
    },
    search: async (action, searchWord, callbackSetList) => {
      CACHE_CALLBACK_SET_LIST = callbackSetList;
      let dbList = CACHE_FUND_DB_LIST && CACHE_FUND_DB_LIST.length > 0 ? CACHE_FUND_DB_LIST : await getMyFundDetails();
      if (searchWord && searchWord.startsWith('s')) {
        searchWord = searchWord.substring(1);
        const newDbList = dbList.filter(d => d.data.id.includes(searchWord) || d.data.name.includes(searchWord));
        if (newDbList.length > 0) {
          dbList = newDbList;
        }
      }
      const cbList = fundDetailsToCbList(dbList, searchWord);
      callbackSetList(cbList);
    }, // 用户选择列表中某个条目时被调用
    select: (action, itemData, callbackSetList) => {
      CACHE_CALLBACK_SET_LIST = callbackSetList;
      if (!CACHE_FUND_DB_LIST || CACHE_FUND_DB_LIST.length === 0) {
        utools.redirect('添加自选基金', '');
        return;
      }
      if (action.type === 'text' && itemData.fundCode) {
        const fundDb = FundDBHelper.get(itemData.fundCode);
        if (itemData.searchWord) {
          const holdCount = parseFloat(itemData.searchWord);
          if (!Number.isNaN(holdCount)) {
            fundDb.data.holdCount = holdCount;
            FundDBHelper.update(fundDb);
          }
        } else {
          showFundDetail(fundDb.data);
          return;
        }
      }
      utools.redirect('我的自选基金', '');
    },
  },
};

export default fundMy;
