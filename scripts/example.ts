import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import path from 'node:path';

await mkdir('examples', { recursive: true });
const examples = [
  [
    'Account access',
    'I cannot sign in after resetting my password. Please help me recover access.',
  ],
  [
    'Export completed',
    'The monthly export has finished successfully. All records are available in the shared folder.',
  ],
  ['Invoice question', 'Could you send a copy of the invoice for order 00427?'],
  [
    'Upload failure',
    'Every attempt to upload the new file fails with an error. We need this fixed before tomorrow.',
  ],
  ['Resolved', 'Thanks, the password reset worked. I can now access my account.'],
  ['Feedback', 'The new dashboard is much easier to use. Nice work on the filters.'],
  [
    'Delivery update',
    'The package has arrived at the regional warehouse and is scheduled for dispatch today.',
  ],
  ['Missing information', 'Please add the destination address to the booking so we can proceed.'],
  [
    'Login loop',
    'The login page keeps redirecting me without signing in. This is blocking my work.',
  ],
  [
    'New contact',
    'Our new office contact is Alex. Please update the contact details in your system.',
  ],
  [
    'Data mismatch',
    'The totals in this report do not match the original records. Can someone investigate?',
  ],
  [
    'Scheduled maintenance',
    'The service will be unavailable for planned maintenance on Sunday morning.',
  ],
];
const zip = new ZipFile();
zip.addBuffer(
  Buffer.from(
    JSON.stringify(
      examples.map(([subject, message], index) => ({
        id: `example-${index + 1}`,
        subject,
        message,
        customer: {
          name: ['Acme', 'Northwind', 'Contoso'][index % 3],
          region: ['EU', 'UK'][index % 2],
        },
        tags: ['sample', 'synthetic'],
        _ts: 1758000000 + index,
      })),
      null,
      2,
    ),
  ),
  'messages.json',
);
zip.addBuffer(
  Buffer.from(
    'id,subject,message\n0013,"New request","Please help me find my latest report."\n0014,"Completed task","The requested changes are now live."\n',
  ),
  'additional-messages.csv',
);
zip.addBuffer(
  Buffer.from(
    'A customer reports that account access has been restored. No further action is requested.',
  ),
  'notes/resolved.txt',
);
zip.end();
await pipeline(zip.outputStream, createWriteStream(path.resolve('examples/exploration.zip')));
console.log(
  'Created examples/exploration.zip: 15 synthetic records across JSON, CSV, and plain text.',
);
