/**
 * Stable PNG URL for the buyer OG card. The colocated
 * `app/(app)/buyers/[wallet]/opengraph-image.tsx` already renders the
 * same image, but Next's metadata-file convention emits a route at
 * `/buyers/<wallet>/opengraph-image-<hash>` where `<hash>` is generated
 * at build time and not knowable from app code. The in-page Share
 * card needs a predictable URL for its "Download image" button, so
 * this thin pass-through delegates to the same render function with
 * a stable mount point.
 */
import OpenGraphImage from '@/app/(app)/buyers/[wallet]/opengraph-image';

export async function GET(_req: Request, ctx: { params: Promise<{ wallet: string }> }) {
  return await OpenGraphImage({ params: ctx.params });
}
