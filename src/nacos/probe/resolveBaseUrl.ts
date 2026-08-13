import { NacosApiError } from '../NacosApiError';
import type { NacosHttpClient } from '../NacosHttpClient';

/**
 * 按顺序要试的 base URL。`/nacos` 不是绝对的：K8s Ingress 和部分 Docker
 * 镜像把服务开在根路径上。
 */
export function candidateBaseUrls(input: string): string[] {
  const trimmed = input.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // 连解析都过不去的地址，也就无从把 userinfo 里的口令摘掉，所以一个字
    // 都不回显——这条消息会进输出通道。
    throw new NacosApiError(
      'validation',
      'The Nacos server address is not a valid URL. It should look like http://host:8848/nacos.'
    );
  }
  // 用户已经给了 context-path（路径非空），照单全收——猜测只会帮倒忙。
  // 原样返回而不是用 origin 重拼，是为了不动用户写下的任何东西。
  if (url.pathname !== '/' && url.pathname !== '') {
    return [trimmed];
  }
  return [`${url.origin}/nacos`, url.origin];
}

/**
 * 提示句后面可能还跟着别的话，所以右边界用前瞻的空白（含换行）或串尾，而
 * 不是行尾锚点：`$` 配 `m` 只在提示恰好独占一行时成立，同一行上多一句
 * 「Please visit ...」就匹配不上了。`\S+?` 的惰性由这个前瞻收口，路径不是
 * `/` 时（运维改过 `nacos.console.contextPath`）也能取全。
 */
const CONSOLE_HINT_PATTERN = /Nacos Console default port is (\d+), and the path is (\S+?)\.?(?=\s|$)/;

export interface NacosConsoleHint {
  port: number;
  path: string;
}

/**
 * Nacos 3.x 的 `NacosConsolePathTipFilter` 会对 `{base}/` 返回一行 text/plain
 * 提示。命中它等于同时确认了「这是 3.x」和「console 在哪个端口」。
 * 1.x/2.x 在同一路径返回控制台 HTML，匹配不上。
 */
export function parseConsoleHint(body: string): NacosConsoleHint | undefined {
  const match = CONSOLE_HINT_PATTERN.exec(body);
  if (!match) {
    return undefined;
  }
  const port = Number.parseInt(match[1], 10);
  if (port < 1 || port > 65535) {
    return undefined;
  }
  return { port, path: match[2] };
}

/**
 * 提示只有一行。给一个小上限，好让明显装不下这句话的 body（1.x/2.x 在同
 * 一路径返回的控制台首页）不必读完——超限时 `requestRaw` 抛
 * `response-too-large`，正好落进下面的 catch。
 */
const CONSOLE_HINT_MAX_BYTES = 8 * 1024;

/**
 * 对 `{base}/` 发一次裸请求，看它是不是 3.x 的 console 提示。
 *
 * 用 `requestRaw` 有两个理由：body 是 text/plain 而非 JSON；以及非 2xx 时
 * 也要 body——这个 filter 回什么状态码没在真机上确认过，能信的只有那句话
 * 本身。
 *
 * 探测不到 console 不是错误，只是「这台不是 3.x，或者它不肯说」。所以任何
 * 已分类的失败都归为 undefined：调用方少一条线索，不该因此少一个连接。
 */
export async function fetchConsoleHint(
  http: Pick<NacosHttpClient, 'requestRaw'>
): Promise<NacosConsoleHint | undefined> {
  try {
    const response = await http.requestRaw('GET', '/', { maxResponseBytes: CONSOLE_HINT_MAX_BYTES });
    return parseConsoleHint(response.text);
  } catch (error) {
    if (error instanceof NacosApiError) {
      return undefined;
    }
    throw error;
  }
}
