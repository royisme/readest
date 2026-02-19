export interface LanguageChapterRules {
  strong: RegExp[];
  weak: RegExp[];
  noise: RegExp[];
  fallbackParagraphsPerChapter: number;
  fallbackMinDetectedChapters: number;
}

const zhStrongRules = [
  /(?:^|\n)\s*(第[零〇一二三四五六七八九十百千万两0-9]+(?:章|卷|节|回|讲|篇|封|本|册|部|话)(?:[：:、 　\(\)0-9]*[^\n-]{0,30})?)(?!\S)/giu,
  /(?:^|\n)\s*((?:楔子|前言|简介|引言|序言|序章|总论|概论|后记)(?:[：: 　][^\n-]{0,30})?)(?!\S)/gu,
];

const zhWeakRules = [
  /(?:^|\n)\s*([一二三四五六七八九十][零〇一二三四五六七八九十百千万]?[：:、 　][^\n-]{0,24})(?=\n|$)/gu,
  /(?:^|\n)\s*(chapter[\s.]*[0-9]+(?:[：:. 　]+[^\n-]{0,50})?)(?!\S)/giu,
];

const zhNoiseRules = [
  /^\d+$/,
  /^(?:https?:\/\/|www\.)/i,
  /^(?:作者|作\s*者|来源|网址|链接)\s*[:：]/,
  /^[-_=~]{6,}$/,
];

export const chapterRulesByLanguage: Record<string, LanguageChapterRules> = {
  zh: {
    strong: zhStrongRules,
    weak: zhWeakRules,
    noise: zhNoiseRules,
    fallbackParagraphsPerChapter: 120,
    fallbackMinDetectedChapters: 5,
  },
};

