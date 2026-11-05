export const CONFIG = {
  ownerJid: '6287892764740@s.whatsapp.net',
  ownerNumbers: ['6287892764740', '087892764740'],
  ownerName: 'eboygcr',

  channelJid: '0029Vb9FGc2KgsNxEKv1kS1y@newsletter',
  channelUrl: 'https://whatsapp.com/channel/0029Vb9FGc2KgsNxEKv1kS1y',

  defaultPrefix: '!',
  chatMilestone: 1000,

  ai: {
    enabled: true,
    model: 'openai',
    systemPrompt: 'Kamu adalah asisten WhatsApp dari EboyGCR Badak Premium. Ramah, santai, singkat. Jawab maksimal 2-3 kalimat dalam bahasa Indonesia. Jangan pernah bahas politik, SARA, atau hal sensitif.',
    cooldownMs: 8000,
    maxHistory: 6,
    pollinationsText: 'https://text.pollinations.ai/openai',
    pollinationsImage: 'https://image.pollinations.ai/prompt/'
  },

  antiBan: {
    jitterFactor: 0.45,
    minReplyDelay: 1200,
    maxReplyDelay: 4800,
    typingMaxMs: 3500,
    spamWindowMs: 10000,
    spamThreshold: 3,
    spamHardThreshold: 5,
    autoClearAfterMs: 60000,
    pushMinGapMs: 25000,
    pushMaxGapMs: 55000,
    maxPushPerRun: 30
  },

  reportKeywords: ['lapor', 'report', 'polisi', 'hukum', 'blokir', 'spam report', 'laporkan', 'kriminal', 'penipuan', 'scam'],

  paket: {
    badak1: { label: '30 MENIT', durMs: 30 * 60 * 1000, harga: '2K' },
    badak2: { label: '5 JAM', durMs: 5 * 60 * 60 * 1000, harga: '5K' },
    badak3: { label: '10 JAM', durMs: 10 * 60 * 60 * 1000, harga: '8K' },
    badak4: { label: '15 JAM', durMs: 15 * 60 * 60 * 1000, harga: '12K' },
    badak5: { label: '20 JAM', durMs: 20 * 60 * 60 * 1000, harga: '20K' },
    badak6: { label: '24 JAM', durMs: 24 * 60 * 60 * 1000, harga: '25K' }
  }
};
