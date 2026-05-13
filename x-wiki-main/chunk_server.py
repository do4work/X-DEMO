#!/usr/bin/env python3
import json
import sys
import tiktoken
from chunknorris.parsers import MarkdownParser
from chunknorris.chunkers import MarkdownChunker
from chunknorris.pipelines import BasePipeline

def chunk_markdown(text: str) -> dict:
    enc = tiktoken.encoding_for_model("text-embedding-3-large")

    chunker = MarkdownChunker(
        max_headers_to_use="h4",
        max_chunk_word_count=0,
        hard_max_chunk_word_count=1200,
        hard_max_chunk_token_count=2200,
        min_chunk_word_count=1,
        tokenizer=enc
    )

    pipeline = BasePipeline(MarkdownParser(), chunker)

    with open("temp_input.md", "w", encoding="utf-8") as f:
        f.write(text)

    chunks = pipeline.chunk_file("temp_input.md")

    result_chunks = []
    for i, c in enumerate(chunks):
        title = ""
        level = 1
        if c.headers and len(c.headers) > 0:
            first_header = c.headers[0]
            if hasattr(first_header, 'text'):
                header_text = first_header.text
                if header_text.startswith('#'):
                    title = header_text.lstrip('#').strip()
                    level = len(header_text) - len(header_text.lstrip('#'))
                else:
                    title = header_text

        result_chunks.append({
            "content": c.get_text(),
            "index": i,
            "title": title,
            "level": level,
            "wordCount": c.word_count if hasattr(c, 'word_count') else 0,
            "tokenCount": len(enc.encode(c.get_text())),
        })

    token_counts = [len(enc.encode(c.get_text())) for c in chunks]

    result = {
        "chunks": result_chunks,
        "stats": {
            "totalChunks": len(chunks),
            "tokenStats": {
                "min": min(token_counts) if token_counts else 0,
                "max": max(token_counts) if token_counts else 0,
                "avg": sum(token_counts) // len(token_counts) if token_counts else 0,
            }
        }
    }

    import os
    if os.path.exists("temp_input.md"):
        os.remove("temp_input.md")

    return result

if __name__ == "__main__":
    try:
        input_data = json.loads(sys.stdin.read())
        text = input_data.get("text", "")
        result = chunk_markdown(text)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        import traceback
        error_result = {"error": str(e), "traceback": traceback.format_exc()}
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)