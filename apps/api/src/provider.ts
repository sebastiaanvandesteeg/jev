import { choice, noul, score, TypeSafeClient, type Questions } from '@typesafe-ai/sdk';
import { responseSchema, type JevResponse, type RequestPreview } from '@jev/shared';

export interface Provider {
  evaluate(request: RequestPreview, signal: AbortSignal): Promise<JevResponse>;
}
export function createProvider(apiKey: string): Provider {
  // Lazy construction keeps importing and browsing usable without credentials.
  let client: TypeSafeClient | undefined;
  return {
    async evaluate(request, signal) {
      client ??= new TypeSafeClient({ apiKey });
      const questions: Questions = {};
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === 'choice')
          questions[id] = choice(question.instructions, question.criteria);
        else if (question.type === 'noul')
          questions[id] = noul(question.instructions, question.criteria);
        else {
          const [first, second, ...rest] = question.criteria;
          questions[id] = score(question.instructions, [first, second, ...rest]);
        }
      }
      return responseSchema.parse(await client.systemOne({ ...request, questions }, { signal }));
    },
  };
}
