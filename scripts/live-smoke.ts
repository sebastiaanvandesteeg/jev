import assert from 'node:assert/strict';
import { buildRequest, runConfigSchema, starters } from '@jev/shared';
import { createProvider } from '../apps/api/src/provider.js';

if (!process.env.TYPESAFE_API_KEY) {
  console.log(
    'Skipped: set TYPESAFE_API_KEY in .env to run one live request using synthetic data.',
  );
} else {
  const config = runConfigSchema.parse({
    name: 'Live SDK smoke test',
    context: 'Account access problems',
    questions: starters.map((s) => s.question),
  });
  const request = buildRequest(
    { message: 'I cannot sign into my account. Please help me restore access.' },
    config,
  );
  const response = await createProvider(process.env.TYPESAFE_API_KEY).evaluate(
    request,
    AbortSignal.timeout(60000),
  );
  assert.equal(response.answers.category.type, 'choice');
  assert.equal(response.answers.needs_attention.type, 'noul');
  assert.equal(response.answers.relevance.type, 'score');
  console.log(
    JSON.stringify(
      { model: response.model, answers: response.answers, usage: response.usage },
      null,
      2,
    ),
  );
}
