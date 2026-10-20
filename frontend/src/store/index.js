import { defineStore } from "pinia";

export const mainStore = defineStore("mainData", {
  state: () => {
    return {
      // 系统主题
      siteTheme: "light",
      siteThemeAuto: true,
      // 新闻类别
      defaultNewsArr: [
        {
          label: "哔哩哔哩",
          name: "bilibili",
          order: 0,
          show: true,
        },
        {
          label: "抖音",
          name: "douyin",
          order: 1,
          show: true,
        },
        {
          label: "快手",
          name: "kuaishou",
          order: 2,
          show: true,
        },
        {
          label: "36氪",
          name: "36kr",
          order: 3,
          show: true,
        },
        {
          label: "少数派",
          name: "sspai",
          order: 4,
          show: true,
        },
        {
          label: "IT之家",
          name: "ithome",
          order: 5,
          show: true,
        },
        {
          label: "澎湃新闻",
          name: "thepaper",
          order: 6,
          show: true,
        },
        {
          label: "今日头条",
          name: "toutiao",
          order: 7,
          show: true,
        },
        {
          label: "稀土掘金",
          name: "juejin",
          order: 8,
          show: true,
        },
        {
          label: "腾讯新闻",
          name: "qq-news",
          order: 9,
          show: true,
        },
        {
          label: "财联社电报",
          name: "cls",
          order: 10,
          show: true,
        },
        {
          label: "界面快报",
          name: "jiemian",
          order: 11,
          show: true,
        },
        {
          label: "界面热门",
          name: "jiemian-hot",
          params: {
            type: "hot",
          },
          order: 12,
          show: true,
        },
        {
          label: "豆瓣讨论小组",
          name: "douban-group",
          order: 13,
          show: true,
        },
        {
          label: "NGA",
          name: "ngabbs",
          order: 14,
          show: true,
        },
        {
          label: "HelloGitHub",
          name: "hellogithub",
          order: 15,
          show: true,
        },
        {
          label: "GitHub",
          name: "github",
          order: 16,
          show: true,
        },
        {
          label: "V2EX",
          name: "v2ex",
          order: 17,
          show: true,
        },
        {
          label: "Hacker News",
          name: "hackernews",
          order: 18,
          show: true,
        },
        {
          label: "路透社·要闻",
          name: "reuters",
          order: 19,
          show: true,
        },
        {
          label: "路透社·国际",
          name: "reuters-world",
          params: {
            type: "world",
          },
          order: 20,
          show: true,
        },
        {
          label: "路透社·商业",
          name: "reuters-business",
          params: {
            type: "business",
          },
          order: 21,
          show: true,
        },
        {
          label: "路透社·科技",
          name: "reuters-technology",
          params: {
            type: "technology",
          },
          order: 22,
          show: true,
        },
        {
          label: "路透社·金融",
          name: "reuters-markets",
          params: {
            type: "markets",
          },
          order: 23,
          show: true,
        },
        {
          label: "金十数据·要闻",
          name: "jin10-important",
          params: {
            type: "important",
          },
          order: 24,
          show: true,
        },
        {
          label: "彭博社·全球",
          name: "bloomberg-world",
          params: {
            type: "world",
          },
          order: 25,
          show: true,
        },
        {
          label: "彭博社·市场",
          name: "bloomberg-markets",
          params: {
            type: "markets",
          },
          order: 26,
          show: true,
        },
      ],
      newsArr: [],
      // 链接跳转方式
      linkOpenType: "open",
      // 页头固定
      headerFixed: true,
      // 时间数据
      timeData: null,
      // 字体大小
      listFontSize: 16,
      // 信息流是否隐藏已看过的内容
      hideReadNews: false,
      // 本地持久化的已读新闻标识集合（存 uniqueKey / newsHash）
      readNewsKeys: [],
    };
  },
  getters: {},
  actions: {
    // 更改系统主题
    setSiteTheme(val) {
      $message.info(`已切换至${val === "dark" ? "深色模式" : "浅色模式"}`, {
        showIcon: false,
      });
      this.siteTheme = val;
      this.siteThemeAuto = false;
    },
    // 检查更新
    checkNewsUpdate() {
      const mainData = JSON.parse(localStorage.getItem("mainData"));
      let updatedNum = 0;
      if (!mainData) {
        if (this.newsArr.length === 0) {
          this.newsArr = this.defaultNewsArr.map((item) => ({ ...item }));
        }
        return false;
      }
      console.log("列表尝试更新", this.defaultNewsArr, this.newsArr);
      // 执行比较并迁移
      if (this.newsArr.length > 0) {
        // 过滤掉已移除的分类，并保留用户自定义的排序和开关状态
        this.newsArr = this.newsArr
          .filter((news) =>
            this.defaultNewsArr.some((item) => item.name === news.name)
          )
          .map((news) => {
            const defaultItem = this.defaultNewsArr.find(
              (item) => item.name === news.name
            );
            return {
              ...defaultItem,
              ...news,
              label: defaultItem.label,
              order: defaultItem.order,
              params: defaultItem.params,
              show: typeof news.show === "boolean" ? news.show : true,
            };
          });
        for (const newItem of this.defaultNewsArr) {
          const exists = this.newsArr.some(
            (news) => newItem.name === news.name
          );
          if (!exists) {
            console.log("列表有更新：", newItem);
            updatedNum++;
            this.newsArr.push({ ...newItem, show: true });
          }
        }
        if (updatedNum) {
          window.$message?.success(`成功更新 ${updatedNum} 个榜单数据`);
        }
      } else {
        console.log("列表无内容，写入默认");
        this.newsArr = this.defaultNewsArr.map((item) => ({ ...item }));
      }
    },
  },
  persist: [
    {
      storage: localStorage,
      paths: [
        "siteTheme",
        "siteThemeAuto",
        "newsArr",
        "linkOpenType",
        "headerFixed",
        "listFontSize",
        "hideReadNews",
        "readNewsKeys",
      ],
    },
  ],
});
