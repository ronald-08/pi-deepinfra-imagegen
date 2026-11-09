/**
 * deepinfra-imagegen — DeepInfra image generation as a pi tool.
 *
 * pi's built-in image pipeline (`codemode` → `models.generateImages`) only speaks
 * OpenRouter's chat-completions image modality, and `models.json` cannot declare
 * image models. DeepInfra serves OpenAI-style images endpoints instead, so this
 * extension registers the harness-native image tool directly.
 *
 * Tool: `generate_image`
 *   - any DeepInfra `image-gen` model (catalog + per-model input schema fetched
 *     from the public API, so parameters always match what the model accepts)
 *   - reference images for edits / established-identity anchoring
 *   - `transparent: true` for cutouts: generates, then runs Bria RMBG for real
 *     PNG alpha (no chroma-keying)
 *   - writes the PNG to `out` and a prompt sidecar at `<out>.json`, which is what
 *     Impeccable's `build-phase advance` reads (and where `"approved": true` goes)
 *
 * Command: `/deepinfra-image [list | <model> | refresh]`
 *
 * Key resolution: pi's credential store for the `deepinfra` provider (stored by
 * `/login deepinfra` or pi-deepinfra's auth), then `DEEPINFRA_API_KEY`, then
 * `~/.pi/agent/auth.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "deepinfra";
const CATALOG_URL = "https://api.deepinfra.com/v1/openai/models";
const MODEL_INFO_URL = (id: string) => `https://api.deepinfra.com/models/${id}`;
const INFERENCE_URL = (id: string) => `https://api.deepinfra.com/v1/inference/${id}`;

const DEFAULT_MODEL = "google/nano-banana-pro";
const BACKGROUND_MODEL = "Bria/remove_background";

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const GENERATION_TIMEOUT_MS = 6 * 60 * 1000;

type JsonSchema = {
	title?: string;
	required?: string[];
	properties?: Record<string, { type?: string; enum?: string[]; default?: unknown }>;
};

type CatalogEntry = { id: string; price?: number; description?: string };

type Cache = {
	fetchedAt: number;
	models: CatalogEntry[];
	schemas: Record<string, JsonSchema>;
};

type GeneratedImage = { data: Buffer; mimeType: string; source: string };

let sessionModel: string | undefined;

// ---------------------------------------------------------------- utilities

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return override ? override : join(homedir(), ".pi", "agent");
}

/** Env values are often present-but-empty; treat those as unset. */
function envModel(): string | undefined {
	const value = process.env.DEEPINFRA_IMAGE_MODEL?.trim();
	return value ? value : undefined;
}

function cachePath(): string {
	return join(agentDir(), "cache", "deepinfra-imagegen.json");
}

function readCache(): Cache {
	try {
		const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<Cache>;
		return { fetchedAt: raw.fetchedAt ?? 0, models: raw.models ?? [], schemas: raw.schemas ?? {} };
	} catch {
		return { fetchedAt: 0, models: [], schemas: {} };
	}
}

function writeCache(cache: Cache): void {
	try {
		mkdirSync(dirname(cachePath()), { recursive: true });
		writeFileSync(cachePath(), JSON.stringify(cache, null, "\t"));
	} catch {
		// cache is best-effort
	}
}

async function getKey(ctx: { modelRegistry: { getApiKeyForProvider(id: string): Promise<string | undefined> } }): Promise<string | undefined> {
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		if (key) return key;
	} catch {
		// provider not registered (pi-deepinfra not installed); fall through
	}
	const envKey = process.env.DEEPINFRA_API_KEY?.trim();
	if (envKey) return envKey;
	try {
		const auth = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf8")) as Record<string, { key?: string }>;
		return auth[PROVIDER]?.key;
	} catch {
		return undefined;
	}
}

function authError(): Error {
	return new Error(
		"No DeepInfra API key. Run `/login deepinfra`, install pi-deepinfra, or set DEEPINFRA_API_KEY.",
	);
}

async function loadCatalog(apiKey: string | undefined, force: boolean): Promise<CatalogEntry[]> {
	const cache = readCache();
	if (!force && cache.models.length > 0 && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) return cache.models;

	// The catalog endpoint is public; send the key when we have one, but do not require it.
	const response = await fetch(CATALOG_URL, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
	});
	if (!response.ok) {
		if (cache.models.length > 0) return cache.models;
		throw new Error(`DeepInfra catalog failed: ${response.status} ${(await response.text()).slice(0, 400)}`);
	}
	const payload = (await response.json()) as { data?: any[] };
	const models: CatalogEntry[] = (payload.data ?? [])
		.filter((m) => (m?.metadata?.tags ?? []).includes("image-gen"))
		.map((m) => ({
			id: String(m.id),
			price: typeof m?.metadata?.pricing?.per_image_unit === "number" ? m.metadata.pricing.per_image_unit : undefined,
			description: typeof m?.metadata?.description === "string" ? m.metadata.description : undefined,
		}));
	writeCache({ ...cache, fetchedAt: Date.now(), models });
	return models;
}

async function loadSchema(model: string, apiKey: string | undefined, force = false): Promise<JsonSchema> {
	const cache = readCache();
	if (!force && cache.schemas[model]) return cache.schemas[model];
	const response = await fetch(MODEL_INFO_URL(model), {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
	});
	if (!response.ok) {
		throw new Error(`Unknown DeepInfra model "${model}" (${response.status}). Run /deepinfra-image to list image models.`);
	}
	const payload = (await response.json()) as { in_schema?: JsonSchema };
	const schema = payload.in_schema ?? {};
	cache.schemas[model] = schema;
	writeCache(cache);
	return schema;
}

function dataUrl(buffer: Buffer, mimeType: string): string {
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function mimeForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

function sniffMime(buffer: Buffer): string {
	if (buffer.length > 8 && buffer[0] === 0x89 && buffer.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
	if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
	if (buffer.length > 12 && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return "application/octet-stream";
}

type RefInput = { dataUrl: string; raw: string };

/**
 * DeepInfra models disagree on how binary inputs arrive: most take a data URL, the
 * Black Forest Labs models take raw base64 (a data URL there fails with "cannot identify
 * image file"). Pick the known encoding first and let the caller retry the other on failure.
 */
type RefEncoding = "dataurl" | "raw";

function preferredEncoding(model: string): RefEncoding {
	return model.startsWith("black-forest-labs/") ? "raw" : "dataurl";
}

function otherEncoding(encoding: RefEncoding): RefEncoding {
	return encoding === "raw" ? "dataurl" : "raw";
}

async function readLocalImage(path: string, cwd: string): Promise<RefInput> {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	if (!existsSync(absolute)) throw new Error(`Reference image not found: ${path}`);
	const buffer = readFileSync(absolute);
	const mimeType = sniffMime(buffer);
	return { dataUrl: dataUrl(buffer, mimeType), raw: buffer.toString("base64") };
}

/** "1440x900" | "16:9" | "2K" → ratios and pixels when the string carries them. */
function parseSize(spec: string): { width?: number; height?: number; ratio?: number; raw: string } {
	const trimmed = spec.trim();
	const pixels = trimmed.match(/^(\d+)\s*[x*×]\s*(\d+)$/i);
	if (pixels) {
		const width = Number(pixels[1]);
		const height = Number(pixels[2]);
		return { width, height, ratio: width / height, raw: trimmed };
	}
	const ratio = trimmed.match(/^(\d+)\s*:\s*(\d+)$/);
	if (ratio) return { ratio: Number(ratio[1]) / Number(ratio[2]), raw: trimmed };
	return { raw: trimmed };
}

function ratioOfSpec(spec: string): number | undefined {
	const match = spec.match(/^(\d+)\s*:\s*(\d+)$/);
	if (!match) return undefined;
	return Number(match[1]) / Number(match[2]);
}

function nearestAspect(ratio: number, allowed: string[]): string {
	let best = allowed[0];
	let bestDiff = Number.POSITIVE_INFINITY;
	for (const candidate of allowed) {
		const value = ratioOfSpec(candidate);
		if (value === undefined) continue;
		const diff = Math.abs(value - ratio);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = candidate;
		}
	}
	return best;
}

function roundTo(value: number, step: number): number {
	return Math.max(step, Math.round(value / step) * step);
}

/** Build the model-specific request body from the model's own input schema. */
function buildBody(options: {
	model: string;
	prompt: string;
	schema: JsonSchema;
	refs: string[];
	size?: string;
	seed?: number;
	count?: number;
}): Record<string, unknown> {
	const { model, prompt, schema, refs, size, seed, count } = options;
	const props = schema.properties ?? {};
	const body: Record<string, unknown> = { prompt };

	if (typeof seed === "number" && props.seed) body.seed = Math.trunc(seed);

	if (refs.length > 0) {
		if (props.image_urls) {
			body.image_urls = refs;
		} else if (props.image) {
			body.image = refs[0];
		} else {
			const slots = Object.keys(props)
				.filter((key) => /^input_image(_\d+)?$/.test(key))
				.sort((a, b) => {
					const index = (key: string) => Number(key.match(/_(\d+)$/)?.[1] ?? "1");
					return index(a) - index(b);
				});
			if (slots.length === 0) {
				throw new Error(`${model} takes no reference image; drop refs or pick an edit model (e.g. google/nano-banana-pro, black-forest-labs/FLUX-2-pro).`);
			}
			refs.slice(0, slots.length).forEach((ref, index) => {
				body[slots[index]] = ref;
			});
		}
	}

	if (typeof count === "number" && count > 1 && props.num_images) body.num_images = Math.trunc(count);

	// Size: width/height pixels, a packed "WxH" string, or an aspect ratio, depending on the model.
	if (props.width && props.height) {
		if (size) {
			const parsed = parseSize(size);
			if (parsed.width && parsed.height) {
				body.width = roundTo(parsed.width, 32);
				body.height = roundTo(parsed.height, 32);
			}
		}
	} else if (props.size) {
		const parsed = size ? parseSize(size) : undefined;
		const alibaba = /^Alibaba/i.test(schema.title ?? "");
		if (parsed?.width && parsed?.height) {
			body.size = alibaba ? `${parsed.width}*${parsed.height}` : `${parsed.width}x${parsed.height}`;
		} else if (size && /^(1K|2K|4K)$/i.test(size.trim())) {
			body.size = size.trim().toUpperCase();
		} else if (size) {
			body.size = size.trim();
		}
	} else if (props.aspect_ratio) {
		const allowed = props.aspect_ratio.enum ?? [];
		const ratio = size ? parseSize(size).ratio : undefined;
		if (ratio && allowed.length > 0) body.aspect_ratio = nearestAspect(ratio, allowed);
		else if (size && allowed.includes(size.trim())) body.aspect_ratio = size.trim();
	}

	if (props.output_format) body.output_format = "png";

	return body;
}

function collectImages(payload: unknown): string[] {
	const record = payload as Record<string, unknown>;
	const found: string[] = [];
	if (Array.isArray(record.images)) {
		for (const item of record.images) {
			if (typeof item === "string") found.push(item);
			else if (item && typeof item === "object") {
				const nested = (item as Record<string, unknown>).url ?? (item as Record<string, unknown>).b64_json;
				if (typeof nested === "string") found.push(nested);
			}
		}
	}
	for (const key of ["image_url", "output", "url"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) found.push(value);
	}
	return found;
}

async function toImage(reference: string, apiKey: string): Promise<GeneratedImage> {
	if (reference.startsWith("data:")) {
		const match = reference.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
		if (!match) throw new Error("Malformed data URL in DeepInfra response");
		const mimeType = match[1] ?? "image/png";
		const data = match[2] ? Buffer.from(match[3] ?? "", "base64") : Buffer.from(decodeURIComponent(match[3] ?? ""), "latin1");
		return { data, mimeType, source: "inline" };
	}
	const url = reference.startsWith("http") ? reference : `https://api.deepinfra.com${reference.startsWith("/") ? "" : "/"}${reference}`;
	// Presigned delivery URLs (BFL, S3/Azure) reject an extra Authorization header.
	const authHeaders = new URL(url).hostname.endsWith("deepinfra.com") ? { Authorization: `Bearer ${apiKey}` } : {};
	const response = await fetch(url, { headers: authHeaders });
	if (!response.ok) throw new Error(`Could not download generated image: ${response.status}`);
	const data = Buffer.from(await response.arrayBuffer());
	return { data, mimeType: response.headers.get("content-type")?.split(";")[0] ?? sniffMime(data), source: url };
}

async function removeBackground(image: GeneratedImage, apiKey: string): Promise<{ image: GeneratedImage; costUsd?: number }> {
	const response = await fetch(INFERENCE_URL(BACKGROUND_MODEL), {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ image: dataUrl(image.data, image.mimeType) }),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Background removal failed: ${response.status} ${text.slice(0, 300)}`);
	const payload = JSON.parse(text) as { images?: string[]; inference_status?: { cost?: number } };
	const images = collectImages(payload);
	if (images.length === 0) throw new Error(`Background removal returned no image: ${text.slice(0, 300)}`);
	return { image: await toImage(images[0], apiKey), costUsd: payload.inference_status?.cost };
}

const MIME_EXTENSION: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
};

/**
 * Not every DeepInfra image model honors a PNG request (sdxl-turbo, Seedream, Qwen can return
 * JPEG). JPEG bytes written into a `.png` path make a file that lies about itself, and Impeccable
 * plates must be real PNGs, so switch to the true extension and say what happened.
 */
function reconcileExtension(requested: string, mimeType: string, warnings: string[], cwd: string): string {
	if (!MIME_EXTENSION[mimeType]) return requested;
	if (mimeForPath(requested) === mimeType) return requested;
	const currentExtension = extname(requested);
	const corrected = requested.slice(0, requested.length - currentExtension.length) + MIME_EXTENSION[mimeType];
	warnings.push(
		`wrote ${relative(cwd, corrected)} instead of ${relative(cwd, requested)}: the model returned ${mimeType}` +
			(mimeType === "image/png" ? "" : ", which is not a PNG"),
	);
	return corrected;
}

function writeSidecar(out: string, sidecar: Record<string, unknown>): string {	const path = `${out}.json`;
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		existing = {};
	}
	writeFileSync(path, JSON.stringify({ ...existing, ...sidecar }, null, 2));
	return path;
}

// --------------------------------------------------------------- registration

export default function deepinfraImageGen(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "generate_image",
		label: "Generate Image (DeepInfra)",
		description:
			"Generate or edit an image with a DeepInfra image model and save it to a path. " +
			"Returns the written path plus a prompt sidecar at <out>.json. Use refs for style, identity, or edit references; " +
			"transparent:true for cutouts needing real PNG alpha (generates, then removes the background with Bria RMBG). " +
			"Models: google/nano-banana-pro (best comps, text, edits), black-forest-labs/FLUX-2-pro (multi-reference edits), " +
			"ByteDance/Seedream-4, stabilityai/sdxl-turbo (cheap drafts).", 
		promptSnippet: "Generate an image with DeepInfra and save it to a file (comps, plates, textured assets)",
		promptGuidelines: [
			"generate_image is the harness-native image tool in this session: it runs DeepInfra image models. When a design workflow (such as impeccable) asks for comps, north-star mocks, plates, or any raster asset, call generate_image instead of reporting that image generation is unavailable.",
			"generate_image must be given the exact output path the workflow declared; it writes a <out>.json prompt sidecar beside every image, which is where an approval flag goes.",
			"generate_image takes refs (existing screenshots, comp crops, card art) for identity-anchored images, and transparent:true only for isolated cutouts, not for full-frame surfaces.",
		],
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The full prompt sent to the model, verbatim." },
				out: { type: "string", description: "Output image path, relative to the project root or absolute." },
				model: { type: "string", description: `DeepInfra image model id. Default ${DEFAULT_MODEL}.` },
				refs: {
					type: "array",
					items: { type: "string" },
					description: "Reference image paths used as input: style/identity anchors, edit sources, or comp crops.",
				},
				size: {
					type: "string",
					description: 'Wanted size: "1440x900" pixels, "16:9" aspect, or "2K"/"4K" where the model takes it.',
				},
				transparent: { type: "boolean", description: "After generation, remove the background to produce real PNG alpha." },
				seed: { type: "number", description: "Seed, when the model supports one." },
				count: { type: "number", description: "Number of images, when the model supports more than one." },
				preview: {
					type: "boolean",
					description: "Show the result to the model inline. Default true when the active model accepts image input.",
				},
			},
			required: ["prompt", "out"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const apiKey = await getKey(ctx);
			if (!apiKey) throw authError();

			const model = (params.model as string | undefined) ?? sessionModel ?? envModel() ?? DEFAULT_MODEL;
			const prompt = String(params.prompt);
			const refs = ((params.refs as string[] | undefined) ?? []).map((ref) => ref);
			const out = String(params.out);
			const absoluteOut = isAbsolute(out) ? out : resolve(ctx.cwd, out);

			onUpdate?.({ content: [{ type: "text", text: `Preparing ${model}…` }], details: { stage: "prepare" } });

			const schema = await loadSchema(model, apiKey);
			const referenceInputs: RefInput[] = [];
			for (const ref of refs) referenceInputs.push(await readLocalImage(ref, ctx.cwd));

			const encode = (encoding: RefEncoding) => referenceInputs.map((input) => input[encoding]);
			const size = params.size as string | undefined;
			const seed = params.seed as number | undefined;
			const count = params.count as number | undefined;

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new Error("DeepInfra generation timed out")), GENERATION_TIMEOUT_MS);
			const onAbort = () => controller.abort(signal?.reason);
			signal?.addEventListener("abort", onAbort, { once: true });
			onUpdate?.({ content: [{ type: "text", text: `${model} is rendering…` }], details: { stage: "render" } });

			let payload: any;
			let body = buildBody({ model, prompt, schema, refs: encode(preferredEncoding(model)), size, seed, count });
			try {
				const post = async (candidate: Record<string, unknown>) => {
					const response = await fetch(INFERENCE_URL(model), {
						method: "POST",
						headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
						body: JSON.stringify(candidate),
						signal: controller.signal,
					});
					return { status: response.status, ok: response.ok, text: await response.text() };
				};

				let result = await post(body);
				// A wrong reference encoding fails as an unusable input image; retry once the other way.
				if (!result.ok && referenceInputs.length > 0 && /image|dimension|decode|corrupt|base64/i.test(result.text)) {
					const alternate = otherEncoding(preferredEncoding(model));
					body = buildBody({ model, prompt, schema, refs: encode(alternate), size, seed, count });
					result = await post(body);
				}
				if (!result.ok) throw new Error(`${model} failed: ${result.status} ${result.text.slice(0, 600)}`);
				payload = JSON.parse(result.text);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}

			const rawImages = collectImages(payload);
			if (rawImages.length === 0) throw new Error(`${model} returned no image: ${JSON.stringify(payload).slice(0, 400)}`);

			const warnings: string[] = [];
			if (Array.isArray(payload.nsfw_content_detected) && payload.nsfw_content_detected.some(Boolean)) {
				warnings.push("the model flagged the output as NSFW");
			}

			let images: GeneratedImage[] = [];
			let extraCost = 0;
			for (const raw of rawImages) images.push(await toImage(raw, apiKey));

			if (params.transparent) {
				onUpdate?.({ content: [{ type: "text", text: "Removing background (Bria RMBG)…" }], details: { stage: "alpha" } });
				const processed = await Promise.all(images.map((image) => removeBackground(image, apiKey)));
				images = processed.map((entry) => entry.image);
				for (const entry of processed) {
					if (typeof entry.costUsd === "number") extraCost += entry.costUsd;
				}
			}

			mkdirSync(dirname(absoluteOut), { recursive: true });
			const written: { path: string; relative: string; sidecar: string; image: GeneratedImage }[] = [];

			for (const [index, image] of images.entries()) {
				const requested = index === 0 ? absoluteOut : absoluteOut.replace(/(\.[^.\\/]+)?$/, `-${index + 1}$1`);
				const actualMime = sniffMime(image.data);
				const target = reconcileExtension(requested, actualMime, warnings, ctx.cwd);
				writeFileSync(target, image.data);
				const sidecar = writeSidecar(target, {
					prompt,
					model,
					provider: PROVIDER,
					size: body.size ?? (body.width ? `${body.width}x${body.height}` : body.aspect_ratio) ?? null,
					refs: refs.length > 0 ? refs : undefined,
					background: params.transparent ? "transparent" : "opaque",
					seed: body.seed ?? null,
					mimeType: actualMime,
					createdAt: new Date().toISOString(),
					costUsd: (payload.inference_status?.cost ?? 0) + extraCost || null,
				});
				written.push({ path: target, relative: relative(ctx.cwd, target), sidecar, image });
			}

			const cost = (payload.inference_status?.cost ?? 0) + extraCost;
			const lines = written.map((entry) => `saved ${entry.relative}`);
			lines.push(`model ${model}${cost ? ` · $${Number(cost).toFixed(4)}` : ""}`);
			if (written.length > 0) lines.push(`sidecar ${relative(ctx.cwd, written[0].sidecar)}`);
			for (const warning of warnings) lines.push(`note: ${warning}`);

			const content: any[] = [{ type: "text", text: lines.join("\n") }];
			const wantsPreview = params.preview ?? Boolean(ctx.model?.input?.includes("image"));
			if (wantsPreview && written.length > 0) {
				const first = written[0];
				if (first.image.data.length <= 8 * 1024 * 1024) {
					content.push({ type: "image", data: first.image.data.toString("base64"), mimeType: sniffMime(first.image.data) });
				}
			}

			return {
				content,
				details: {
					model,
					costUsd: cost || null,
					images: written.map((entry) => ({ path: entry.relative, sidecar: entry.sidecar })),
					warnings,
				},
			};
		},
	});

	pi.registerCommand("deepinfra-image", {
		description: "List DeepInfra image models, set the session model, or refresh the cached catalog",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const apiKey = await getKey(ctx);
			if (!apiKey) {
				ctx.ui.notify("No DeepInfra API key. Run /login deepinfra or set DEEPINFRA_API_KEY.", "error");
				return;
			}

			if (raw && raw !== "list" && raw !== "refresh") {
				try {
					await loadSchema(raw, apiKey);
					sessionModel = raw;
					ctx.ui.notify(`Image model for this session: ${raw}`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			try {
				const models = await loadCatalog(apiKey, raw === "refresh");
				const active = sessionModel ?? envModel() ?? DEFAULT_MODEL;
				const lines = models
					.slice()
					.sort((a, b) => a.id.localeCompare(b.id))
					.map((entry) => {
						const price = entry.price !== undefined ? `$${entry.price.toFixed(4)}/image` : "price n/a";
						return `${entry.id === active ? "*" : " "} ${entry.id}  ${price}`;
					});
				ctx.ui.notify(`DeepInfra image models (active: ${active}):\n${lines.join("\n")}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
