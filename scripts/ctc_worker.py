"""Local acoustic emissions for the planned follower; no lyrics enter this model."""
import argparse
import gc
import hashlib
import itertools
import json
import sys
import time
import wave
from pathlib import Path

import numpy as np


class AcousticModel:
    def __init__(self, model, vocab, threads=4):
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
        self.info = {"backend": "onnxruntime", "runtimeVersion": ort.__version__}
        vocabulary = json.loads(Path(vocab).read_text())
        self.labels = [token for token, _ in sorted(vocabulary.items(), key=lambda pair: pair[1])]
        self.blank = vocabulary["<pad>"]

    def infer(self, pcm):
        started = time.perf_counter()
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
        inputs = {"input_values": audio[np.newaxis, :]}
        if any(item.name == "attention_mask" for item in self.session.get_inputs()):
            inputs["attention_mask"] = np.ones_like(inputs["input_values"], dtype=np.int64)
        logits = self.session.run(None, inputs)[0][0]
        logits -= logits.max(axis=-1, keepdims=True)
        log_probs = logits - np.log(np.exp(logits).sum(axis=-1, keepdims=True))
        best = logits.argmax(axis=-1).tolist()
        collapsed = [key for key, _ in itertools.groupby(best) if key != self.blank]
        text = "".join(self.labels[index] for index in collapsed if len(self.labels[index]) == 1).replace("|", " ").strip()
        return {"logProbs": log_probs.round(5).tolist(), "text": text,
                "frameOffsetMs": 12.5, "frameStepMs": 20,
                "decodeMs": round((time.perf_counter() - started) * 1000)}


class MusicAcousticModel:
    """Music-trained CTC encoder. The target lyrics never enter the encoder."""
    def __init__(self, model, vocab, threads=4):
        import torch
        from transformers import Wav2Vec2BertForCTC, Wav2Vec2BertProcessor
        torch.set_num_threads(threads)
        torch.set_num_interop_threads(1)
        self.torch = torch
        self.info = {"backend": "torch-dynamic-qint8", "runtimeVersion": torch.__version__,
                     "quantizedEngine": torch.backends.quantized.engine, "englishProjection": True}
        directory = str(Path(model).parent)
        self.processor = Wav2Vec2BertProcessor.from_pretrained(directory, local_files_only=True)
        self.model = Wav2Vec2BertForCTC.from_pretrained(directory, local_files_only=True).eval()
        torch.ao.quantization.quantize_dynamic(self.model, {torch.nn.Linear}, dtype=torch.qint8, inplace=True)
        gc.collect()
        vocabulary = json.loads(Path(vocab).read_text())
        blank = vocabulary["<blank>"]
        # Keep the original probabilities, including probability lost to other scripts.
        # Projecting the output makes English replay files much smaller; no renormalization.
        selected = sorted((index, token) for token, index in vocabulary.items()
                          if len(token) == 1 and token in "abcdefghijklmnopqrstuvwxyz'|" or index == blank)
        self.indices = torch.tensor([index for index, _ in selected], dtype=torch.long)
        self.labels = [token for _, token in selected]
        self.blank = [index for index, _ in selected].index(blank)

    def infer(self, pcm):
        started = time.perf_counter()
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        inputs = self.processor(audio, sampling_rate=16000, return_tensors="pt")
        with self.torch.inference_mode():
            logits = self.model(**inputs).logits
            log_probs = logits.log_softmax(-1)[0].index_select(-1, self.indices).numpy()
        text = self.processor.batch_decode(logits.argmax(-1))[0]
        return {"logProbs": log_probs.round(5).tolist(), "text": text,
                "frameOffsetMs": 17.5, "frameStepMs": 20,
                "decodeMs": round((time.perf_counter() - started) * 1000)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--vocab", required=True)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    backend = MusicAcousticModel if args.model.endswith(".safetensors") else AcousticModel
    acoustic = backend(args.model, args.vocab, args.threads)
    with open(args.model, 'rb') as model_file:
        model_hash = hashlib.file_digest(model_file, 'sha256').hexdigest()
    print(json.dumps({"type": "ready", "labels": acoustic.labels, "blank": acoustic.blank,
                      "model": {"path": str(Path(args.model).resolve()), "sha256": model_hash, **acoustic.info}}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        try:
            with wave.open(request["file"], "rb") as audio:
                if audio.getframerate() != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
                    raise ValueError("CTC input must be mono PCM16 at 16 kHz")
                pcm = audio.readframes(audio.getnframes())
            result = acoustic.infer(pcm)
            print(json.dumps({"type": "result", "id": request["id"], **result}), flush=True)
        except Exception as error:
            print(json.dumps({"type": "error", "id": request.get("id"), "message": str(error)}), flush=True)


if __name__ == "__main__":
    main()
