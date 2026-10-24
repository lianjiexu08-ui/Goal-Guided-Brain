import { createHash } from 'node:crypto';

// Limited to the published beta.9 adapter. Upgrades must re-evaluate this patch.
const originalHash =
  '4bd697c810bc26c2ff8237d18800bc70e4048c239f59d171b51ba45900d0e6b8';
const changes = [
  [
    'function nodeToWebRequest(req, urlOverride, prerenderSecret, i18nConfig, authorizeOnDemandRevalidate) {',
    'function nodeToWebRequest(req, urlOverride, prerenderSecret, i18nConfig, authorizeOnDemandRevalidate, signal) {',
  ],
  [
    '\t\tmethod,\n\t\theaders\n\t};',
    '\t\tmethod,\n\t\theaders,\n\t\tsignal\n\t};',
  ],
  [
    'async function sendWebResponse(webResponse, req, res, compress) {',
    `async function sendWebResponse(webResponse, req, res, compress) {
	if (res.destroyed || res.writableEnded) {
		cancelResponseBody(webResponse);
		return;
	}`,
  ],
  [
    '\t\ttry {\n\t\t\tconst request = nodeToWebRequest(req, rawUrl, prerenderSecret, appRouterI18nConfig, appRouterAuthorizeOnDemandRevalidate);',
    `		// GGB: propagate response disconnection, not IncomingMessage completion.
		const controller = new AbortController();
		const cleanup = () => {
			req.off("aborted", disconnected);
			res.off("close", disconnected);
			res.off("finish", cleanup);
		};
		const disconnected = () => {
			cleanup();
			if (!res.writableFinished) controller.abort(new DOMException("Client disconnected", "AbortError"));
		};
		req.once("aborted", disconnected);
		res.once("close", disconnected);
		res.once("finish", cleanup);
		if (req.aborted || res.destroyed) disconnected();
		try {
			const request = nodeToWebRequest(req, rawUrl, prerenderSecret, appRouterI18nConfig, appRouterAuthorizeOnDemandRevalidate, controller.signal);`,
  ],
  [
    '\t\t\tawait sendWebResponse(response, req, res, compress);\n\t\t} catch (e) {\n\t\t\tconsole.error("[vinext] Server error:", e);\n\t\t\tif (!res.headersSent) {',
    `			await sendWebResponse(response, req, res, compress);
		} catch (e) {
			if (controller.signal.aborted && (e === controller.signal.reason || e?.name === "AbortError")) return;
			console.error("[vinext] Server error:", e);
			if (!res.headersSent && !res.destroyed && !res.writableEnded) {`,
  ],
];
const hash = (source) => createHash('sha256').update(source).digest('hex');

export function patchVinext(source, version) {
  if (version !== '1.0.0-beta.9')
    throw Error(`Review the GGB connection patch for vinext ${version}.`);
  let original = source;
  if (hash(original) !== originalHash) {
    for (const [before, after] of [...changes].reverse())
      original = original.replace(after, before);
    if (hash(original) !== originalHash)
      throw Error(
        'Unexpected vinext production adapter; refusing to patch it.',
      );
  }
  for (const [before, after] of changes) {
    if (original.split(before).length !== 2)
      throw Error('Vinext patch anchor is missing or ambiguous.');
    original = original.replace(before, after);
  }
  if (hash(source) !== originalHash && source !== original)
    throw Error('Incomplete vinext patch; reinstall the pinned package.');
  return original;
}
