import { readFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import * as ort from "onnxruntime-web";

// Runs ONE background-removal inference, then exits.
//
// Why a worker, and a short-lived one:
//   * the inference takes seconds of pure CPU; on the main thread it would
//     freeze every other request the API is serving for that long;
//   * the WebAssembly runtime keeps its heap (hundreds of MB) for the life of
//     the thread. Ending the thread after each cut-out hands that memory back
//     instead of pinning it in the API process forever.
//
// onnxruntime-web (WebAssembly) rather than onnxruntime-node: the API image is
// Alpine (musl), for which onnxruntime-node ships no binary.

interface Job {
  modelPath: string;
  size: number;
  input: Float32Array;
}

const job = workerData as Job;

ort.env.wasm.numThreads = 1;

try {
  const session = await ort.InferenceSession.create(readFileSync(job.modelPath));
  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;
  const output = await session.run({
    [inputName]: new ort.Tensor("float32", job.input, [1, 3, job.size, job.size]),
  });
  const mask = Float32Array.from(output[outputName]!.data as Float32Array);
  await session.release();
  parentPort!.postMessage({ ok: true, mask }, [mask.buffer]);
} catch (err) {
  parentPort!.postMessage({ ok: false, error: (err as Error).message });
}
