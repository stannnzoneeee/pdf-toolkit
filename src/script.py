import sys
import json

def main():
    # Read JSON config from stdin
    cfg = json.load(sys.stdin)
    text = cfg.get("text", "")  # Pass through without reversing

    # Output the text directly
    print(text)

if __name__ == "__main__":
    main()