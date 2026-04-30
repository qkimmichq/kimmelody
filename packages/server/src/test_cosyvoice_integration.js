import 'dotenv/config';
import { TTS } from './modules/tts.js';

const tts = new TTS({ cacheDir: './cache/tts' });

console.log('Testing CosyVoice TTS integration...');
const result = await tts.synthesize('大家好，我是Kimmelody电台的AI DJ孙燕姿，欢迎收听今天的节目', 'default');
if (result) {
  console.log('SUCCESS:', result);
} else {
  console.log('FAILED: TTS returned null');
}
