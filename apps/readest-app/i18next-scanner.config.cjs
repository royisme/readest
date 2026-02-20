const i18nOptions = require('./i18next-options.json');

module.exports = {
  input: ['src/**/*.{js,jsx,ts,tsx}', '!src/**/*.test.{js,jsx,ts,tsx}'],
  output: '.',
  options: {
    debug: false,
    sort: false,
    func: {
      list: ['_'],
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    },
    lngs: i18nOptions.lngs,
    ns: i18nOptions.ns,
    defaultNs: i18nOptions.defaultNs,
    defaultValue: '__STRING_NOT_TRANSLATED__',
    resource: {
      loadPath: './public/locales/{{lng}}/{{ns}}.json',
      savePath: './public/locales/{{lng}}/{{ns}}.json',
      jsonIndent: 2,
      lineEnding: '\n',
    },
    keySeparator: false,
    nsSeparator: false,
    interpolation: {
      prefix: '{{',
      suffix: '}}',
    },
    metadata: {},
    allowDynamicKeys: true,
    removeUnusedKeys: true,
  },
};
