import { emptyTrash, listTrash } from "@/lib/local-dataset-trash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET` what is in the trash; `DELETE` to destroy it and reclaim the space. */
export async function GET(): Promise<Response> {
  const entries = await listTrash();
  return Response.json({
    entries,
    count: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  });
}

export async function DELETE(): Promise<Response> {
  try {
    return Response.json(await emptyTrash());
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Failed to empty the trash",
      },
      { status: 500 },
    );
  }
}
