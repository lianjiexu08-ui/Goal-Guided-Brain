const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    protocol: 'chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keys: ['DEEPSEEK_API_KEY'],
  },
  kimi: {
    label: 'Kimi',
    protocol: 'chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  },
  gemini: {
    label: 'Gemini',
    protocol: 'chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  claude: {
    label: 'Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    keys: ['ANTHROPIC_API_KEY'],
  },
  codex: {
    label: 'Codex/OpenAI',
    protocol: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-codex',
    keys: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  },
};

const PROVIDER_ALIASES = { gpt: 'codex', openai: 'codex' };

const CLI_NAME = 'ggb';

function valueAfter(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
}

function has(args, flag) {
  return args.includes(flag);
}

function presetFor(name) {
  const requested = String(name || '')
    .trim()
    .toLowerCase();
  const canonical = PROVIDER_ALIASES[requested] || requested;
  const preset = PRESETS[canonical];
  if (!preset)
    throw new Error(
      `未知供应商“${name}”，可选：${Object.keys(PRESETS).join('、')}（gpt/openai 为 Codex/OpenAI 别名）`,
    );
  return { name: canonical, preset };
}

function pickKey(preset, explicit) {
  if (explicit) return explicit;
  for (const name of preset.keys)
    if (process.env[name]) return process.env[name];
  return '';
}
export { PRESETS, CLI_NAME, valueAfter, has, presetFor, pickKey };
