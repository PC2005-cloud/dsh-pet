// 测试入口预载：注册 test-ts-resolver（见其头部注释）。用法：node --import ./scripts/test-register.mjs
import { register } from 'node:module';

register('./test-ts-resolver.mjs', import.meta.url);
