/**
 * Stable PNG URL for the RFP OG card. See the buyer route for the
 * full rationale — this exists so the in-page Share card can wire
 * a predictable "Download image" link instead of chasing the hashed
 * `opengraph-image-<id>` URL Next's metadata convention emits.
 */
import OpenGraphImage from '@/app/(app)/rfps/[id]/opengraph-image';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return await OpenGraphImage({ params: ctx.params });
}
