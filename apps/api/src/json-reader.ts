import { createReadStream } from 'node:fs';
import { parserStream } from 'stream-json';
import type { Json } from '@jev/shared';

interface Token {
  name: string;
  value?: string | boolean | null;
}
interface Frame {
  kind: 'object' | 'array';
  path: string;
  key: string;
  index: number;
}
const escape = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
async function* tokens(file: string): AsyncGenerator<Token> {
  const source = createReadStream(file);
  const stream = parserStream({ streamKeys: false, streamStrings: false, streamNumbers: false });
  source.on('error', (e) => stream.destroy(e));
  source.pipe(stream);
  try {
    for await (const token of stream) yield token;
  } finally {
    source.destroy();
    stream.destroy();
  }
}
function valuePath(stack: Frame[]): string {
  const parent = stack.at(-1);
  if (!parent) return '';
  return `${parent.path}/${parent.kind === 'array' ? parent.index++ : escape(parent.key)}`;
}
const starts = (name: string) => name === 'startObject' || name === 'startArray';
const ends = (name: string) => name === 'endObject' || name === 'endArray';

/** Scan without building the document, including large wrapper arrays. JSON Pointer avoids ambiguous dotted keys. */
export async function inspectJson(
  file: string,
): Promise<{ rootArray: boolean; arrayPaths: string[] }> {
  const stack: Frame[] = [];
  const arrayPaths: string[] = [];
  let rootArray = false;
  for await (const token of tokens(file)) {
    if (token.name === 'keyValue') {
      stack.at(-1)!.key = String(token.value);
      continue;
    }
    if (ends(token.name)) {
      stack.pop();
      continue;
    }
    const path = valuePath(stack);
    if (starts(token.name)) {
      if (token.name === 'startArray') {
        if (!stack.length) rootArray = true;
        else if (!stack.some((f) => f.kind === 'array') && arrayPaths.length < 200)
          arrayPaths.push(path);
      }
      if (stack.length >= 256) throw new Error('JSON nesting exceeds the supported depth of 256.');
      stack.push({
        kind: token.name === 'startArray' ? 'array' : 'object',
        path,
        key: '',
        index: 0,
      });
    }
  }
  return { rootArray, arrayPaths };
}

class Builder {
  value: Json = null;
  stack: { container: Json[] | Record<string, Json>; key: string }[] = [];
  add(value: Json) {
    const frame = this.stack.at(-1);
    if (!frame) this.value = value;
    else if (Array.isArray(frame.container)) frame.container.push(value);
    else
      Object.defineProperty(frame.container, frame.key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  consume(token: Token) {
    if (token.name === 'keyValue') {
      this.stack.at(-1)!.key = String(token.value);
      return;
    }
    if (ends(token.name)) {
      this.stack.pop();
      return;
    }
    if (starts(token.name)) {
      const container = token.name === 'startArray' ? [] : {};
      this.add(container);
      this.stack.push({ container, key: '' });
    } else {
      this.add(
        token.name === 'numberValue'
          ? Number(token.value)
          : token.name === 'trueValue'
            ? true
            : token.name === 'falseValue'
              ? false
              : token.name === 'nullValue'
                ? null
                : String(token.value),
      );
    }
  }
}

/** null means one complete document; a pointer means one record for each element of that array. */
export async function* readJson(file: string, arrayPointer: string | null): AsyncGenerator<Json> {
  const stack: Frame[] = [];
  let builder: Builder | null = null;
  let captureDepth = 0;
  let found = arrayPointer === null;
  for await (const token of tokens(file)) {
    if (token.name === 'keyValue') {
      stack.at(-1)!.key = String(token.value);
      builder?.consume(token);
      continue;
    }
    if (ends(token.name)) {
      builder?.consume(token);
      stack.pop();
      if (builder && stack.length === captureDepth) {
        yield builder.value;
        builder = null;
      }
      continue;
    }
    const parent = stack.at(-1);
    const path = valuePath(stack);
    if (token.name === 'startArray' && path === arrayPointer) found = true;
    if (
      !builder &&
      ((arrayPointer === null && !stack.length) ||
        (parent?.kind === 'array' && parent.path === arrayPointer))
    ) {
      builder = new Builder();
      captureDepth = stack.length;
    }
    builder?.consume(token);
    if (starts(token.name))
      stack.push({
        kind: token.name === 'startArray' ? 'array' : 'object',
        path,
        key: '',
        index: 0,
      });
    else if (builder && stack.length === captureDepth) {
      yield builder.value;
      builder = null;
    }
  }
  if (!found) throw new Error(`No array exists at ${arrayPointer}.`);
}
