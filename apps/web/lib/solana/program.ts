import * as tenderClient from '@tender/tender-client';

import { tenderProgramId } from './client';

export { tenderProgramId };
export const tender = tenderClient;
export const findRfpPda = tenderClient.findRfpPda;
export const findBidPda = tenderClient.findBidPda;
