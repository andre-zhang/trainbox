/** Tiny health check — confirms /api routes run (no DB). */
export default {
  fetch() {
    return Response.json({ ok: true })
  },
}
