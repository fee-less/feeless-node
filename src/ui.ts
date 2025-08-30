import readline from "readline";

export class SplitTerminalUI {
  private leftBuffer: string[] = [];
  private rightBuffer: string[] = [];
  private terminalWidth: number;
  private terminalHeight: number;
  private splitPosition: number;
  private isInitialized = false;
  private leftScrollOffset = 0;
  private rightScrollOffset = 0;
  private rl: readline.Interface | null = null;

  constructor() {
    this.terminalWidth = process.stdout.columns || 120;
    this.terminalHeight = process.stdout.rows || 30;
    this.splitPosition = Math.floor(this.terminalWidth / 2);
    this.initialize();
  }

  private initialize(): void {
    // Clear screen and hide cursor
    process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

    // Disable default terminal scrolling behavior
    process.stdout.write("\x1b[?47h"); // Switch to alternate screen buffer
    process.stdout.write("\x1b[?1049h"); // Enable alternate screen

    // Setup readline for input handling
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Setup input handlers
    this.setupInputHandlers();

    // Setup resize handler
    process.stdout.on("resize", () => {
      this.terminalWidth = process.stdout.columns || 120;
      this.terminalHeight = process.stdout.rows || 30;
      this.splitPosition = Math.floor(this.terminalWidth / 2);
      this.render();
    });

    this.isInitialized = true;
    this.render();
  }

  private setupInputHandlers(): void {
    if (!this.rl) return;

    // Set raw mode to capture individual keypresses
    process.stdin.setRawMode(true);

    process.stdin.on("data", (chunk) => {
      const data = chunk.toString();

      // Handle escape sequences for arrow keys
      if (data === "\x1b[A") {
        // Up arrow
        this.scrollUp();
      } else if (data === "\x1b[B") {
        // Down arrow
        this.scrollDown();
      } else if (data === "\x1b[C") {
        // Right arrow - scroll right pane up
        this.scrollRightUp();
      } else if (data === "\x1b[D") {
        // Left arrow - scroll left pane up
        this.scrollLeftUp();
      } else if (data === "c" || data === "C") {
        // C to clear
        this.clear();
      } else if (data === "r" || data === "R") {
        // R to reset scroll
        this.resetScroll();
      }
    });
  }

  private scrollUp(): void {
    const availableLines = this.getAvailableLines();
    const maxLeftScroll = Math.max(0, this.leftBuffer.length - availableLines);
    const maxRightScroll = Math.max(
      0,
      this.rightBuffer.length - availableLines
    );

    if (this.leftScrollOffset < maxLeftScroll) {
      this.leftScrollOffset++;
    }
    if (this.rightScrollOffset < maxRightScroll) {
      this.rightScrollOffset++;
    }
    this.render();
  }

  private scrollDown(): void {
    if (this.leftScrollOffset > 0) {
      this.leftScrollOffset--;
    }
    if (this.rightScrollOffset > 0) {
      this.rightScrollOffset--;
    }
    this.render();
  }

  private scrollLeftUp(): void {
    const availableLines = this.getAvailableLines();
    const maxScroll = Math.max(0, this.leftBuffer.length - availableLines);

    if (this.leftScrollOffset < maxScroll) {
      this.leftScrollOffset++;
      this.render();
    }
  }

  private scrollRightUp(): void {
    const availableLines = this.getAvailableLines();
    const maxScroll = Math.max(0, this.rightBuffer.length - availableLines);

    if (this.rightScrollOffset < maxScroll) {
      this.rightScrollOffset++;
      this.render();
    }
  }

  private resetScroll(): void {
    this.leftScrollOffset = 0;
    this.rightScrollOffset = 0;
    this.render();
  }

  private getAvailableLines(): number {
    return this.terminalHeight - 4; // Header, separator, controls info, and bottom margin
  }

  private wrapText(text: string, maxWidth: number): string[] {
    if (maxWidth <= 0) return [text];

    const lines: string[] = [];
    let currentLine = "";
    let currentVisibleLength = 0;
    let inEscape = false;
    let escapeSequence = "";

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (char === "\x1b") {
        inEscape = true;
        escapeSequence = char;
      } else if (inEscape) {
        escapeSequence += char;
        if (char === "m") {
          inEscape = false;
          currentLine += escapeSequence;
          escapeSequence = "";
        }
      } else {
        if (currentVisibleLength >= maxWidth) {
          lines.push(currentLine);
          currentLine = "";
          currentVisibleLength = 0;
        }
        currentLine += char;
        currentVisibleLength++;
      }
    }

    if (currentLine.length > 0 || lines.length === 0) {
      lines.push(currentLine);
    }

    return lines;
  }

  private render(): void {
    if (!this.isInitialized) return;

    // Clear screen
    process.stdout.write("\x1b[2J\x1b[H");

    // Draw header
    const leftHeader = " STATUS & SYNC ";
    const rightHeader = " BLOCKCHAIN & ERRORS ";
    const leftPadding = Math.max(
      0,
      Math.floor((this.splitPosition - leftHeader.length) / 2)
    );
    const rightPadding = Math.max(
      0,
      Math.floor(
        (this.terminalWidth - this.splitPosition - rightHeader.length) / 2
      )
    );

    process.stdout.write("\x1b[7m"); // Invert colors
    process.stdout.write(
      " ".repeat(leftPadding) +
        leftHeader +
        " ".repeat(this.splitPosition - leftPadding - leftHeader.length)
    );
    process.stdout.write("│");
    process.stdout.write(
      " ".repeat(rightPadding) +
        rightHeader +
        " ".repeat(
          this.terminalWidth -
            this.splitPosition -
            1 -
            rightPadding -
            rightHeader.length
        )
    );
    process.stdout.write("\x1b[0m\n"); // Reset colors

    // Draw separator line
    process.stdout.write(
      "─".repeat(this.splitPosition) +
        "┼" +
        "─".repeat(this.terminalWidth - this.splitPosition - 1) +
        "\n"
    );

    // Calculate available lines for content
    const availableLines = this.getAvailableLines();

    // Wrap messages and create flat arrays of display lines
    const leftDisplayLines: string[] = [];
    const rightDisplayLines: string[] = [];

    // Process left buffer with wrapping
    for (const message of this.leftBuffer) {
      const wrappedLines = this.wrapText(message, this.splitPosition - 1);
      leftDisplayLines.push(...wrappedLines);
    }

    // Process right buffer with wrapping
    const maxRightWidth = this.terminalWidth - this.splitPosition - 1;
    for (const message of this.rightBuffer) {
      const wrappedLines = this.wrapText(message, maxRightWidth);
      rightDisplayLines.push(...wrappedLines);
    }

    // Get lines based on scroll position
    const leftStartIndex = Math.max(
      0,
      leftDisplayLines.length - availableLines - this.leftScrollOffset
    );
    const rightStartIndex = Math.max(
      0,
      rightDisplayLines.length - availableLines - this.rightScrollOffset
    );

    const leftLines = leftDisplayLines.slice(
      leftStartIndex,
      leftStartIndex + availableLines
    );
    const rightLines = rightDisplayLines.slice(
      rightStartIndex,
      rightStartIndex + availableLines
    );

    // Draw exactly availableLines number of lines
    for (let i = 0; i < availableLines; i++) {
      const leftLine = leftLines[i] || "";
      const rightLine = rightLines[i] || "";

      // Pad left side to exact width
      const paddedLeft = this.padWithColors(leftLine, this.splitPosition);

      process.stdout.write(paddedLeft + "│" + rightLine + "\n");
    }

    // Draw controls info at bottom
    const controlsInfo =
      " ↑↓:Scroll Both │ ←→:Scroll Individual │ C:Clear │ R:Reset │ Q:Quit ";
    const controlsPadding = Math.max(
      0,
      Math.floor((this.terminalWidth - controlsInfo.length) / 2)
    );
    process.stdout.write("\x1b[2m"); // Dim text
    process.stdout.write(" ".repeat(controlsPadding) + controlsInfo);
    process.stdout.write("\x1b[0m"); // Reset colors
  }

  private getVisibleLength(text: string): number {
    // Remove ANSI escape codes to get actual visible length
    return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").length;
  }

  private padWithColors(text: string, totalWidth: number): string {
    const visibleLength = this.getVisibleLength(text);
    const paddingNeeded = Math.max(0, totalWidth - visibleLength);
    return text + " ".repeat(paddingNeeded);
  }

  public logLeft(message: string, overwrite: boolean = false): void {
    if (overwrite && this.leftBuffer.length > 0) {
      this.leftBuffer[this.leftBuffer.length - 1] = message;
    } else {
      this.leftBuffer.push(message);
    }

    // Keep buffer size manageable
    if (this.leftBuffer.length > 1000) {
      this.leftBuffer = this.leftBuffer.slice(-500);
      // Adjust scroll offset if needed
      this.leftScrollOffset = Math.max(0, this.leftScrollOffset - 500);
    }

    // Auto-scroll to bottom if we're at the bottom
    if (this.leftScrollOffset === 0) {
      this.render();
    }
  }

  public logRight(message: string, overwrite: boolean = false): void {
    if (overwrite && this.rightBuffer.length > 0) {
      this.rightBuffer[this.rightBuffer.length - 1] = message;
    } else {
      this.rightBuffer.push(message);3
    }

    // Keep buffer size manageable
    if (this.rightBuffer.length > 1000) {
      this.rightBuffer = this.rightBuffer.slice(-500);
      // Adjust scroll offset if needed
      this.rightScrollOffset = Math.max(0, this.rightScrollOffset - 500);
    }

    // Auto-scroll to bottom if we're at the bottom
    if (this.rightScrollOffset === 0) {
      this.render();
    }
  }

  public shutdown(): void {
    if (this.isInitialized) {
      // Restore terminal state
      process.stdin.setRawMode(false);
      if (this.rl) {
        this.rl.close();
      }

      // Restore normal screen buffer and show cursor
      process.stdout.write("\x1b[?1049l"); // Disable alternate screen
      process.stdout.write("\x1b[?47l"); // Switch back to normal screen buffer
      process.stdout.write("\x1b[?25h"); // Show cursor
      process.stdout.write("\x1b[2J\x1b[H"); // Clear and go to top

      this.isInitialized = false;
    }
  }

  public clear(): void {
    this.leftBuffer = [];
    this.rightBuffer = [];
    this.leftScrollOffset = 0;
    this.rightScrollOffset = 0;
    this.render();
  }

  public clearLeft(): void {
    this.leftBuffer = [];
    this.leftScrollOffset = 0;
    this.render();
  }

  public clearRight(): void {
    this.rightBuffer = [];
    this.rightScrollOffset = 0;
    this.render();
  }
}
