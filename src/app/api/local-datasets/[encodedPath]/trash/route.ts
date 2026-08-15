import { NextRequest } from "next/server";
import { trashDataset } from "@/lib/local-dataset-trash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST …/[encodedPath]/trash` — move one dataset into the corpus trash.
 *
 * Deliberately not `DELETE` on the dataset URL: this is the one route in the
 * viewer that takes data away from the user, and it should be impossible to
 * trigger by a stray method on a path that otherwise serves files.
 *
 * Nothing is destroyed here — see `emptyTrash` in `lib/local-dataset-trash.ts`.
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ encodedPath: string }> },
): Promise<Response> {
  const { encodedPath } = await ctx.params;
  const outcome = await trashDataset(encodedPath);
  if (!outcome.ok) {
    return Response.json({ error: outcome.error }, { status: outcome.status });
  }
  return Response.json({ trashed: outcome.entry });
}
