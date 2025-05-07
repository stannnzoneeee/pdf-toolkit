const { ipcRenderer } = require('electron');

const browseBtn       = document.getElementById('browseBtn');
const filePathDisplay = document.getElementById('filePath');
const pdfTextArea     = document.getElementById('pdfText');
const processBtn      = document.getElementById('processBtn');
const processedOut    = document.getElementById('processed');

// Browse and extract PDF text
browseBtn.addEventListener('click', async () => {
  const paths = await ipcRenderer.invoke('dialog:openFile');
  if (!paths || paths.length === 0) {
    filePathDisplay.innerText = 'No file selected.';
    return;
  }

  const pdfPath = paths[0];
  filePathDisplay.innerText = `Selected File: ${pdfPath}`;

  const result = await ipcRenderer.invoke('pdf:parse', pdfPath);
  if (result.success) {
    pdfTextArea.value = result.text;
  } else {
    pdfTextArea.value = `❌ Failed to extract text:\n${result.error}`;
  }
});

// Example: run Python script on extracted text
processBtn.addEventListener('click', async () => {
  const text = pdfTextArea.value;
  if (!text) return;

  try {
    const reversed = await runPython(text);
    processedOut.innerText = reversed;
  } catch (err) {
    processedOut.innerText = 'Error: ' + err.message;
  }
});

// Helper to spawn Python
const { spawn } = require('child_process');
const path = require('path');
function runPython(textToProcess) {
  return new Promise((resolve, reject) => {
    const py = spawn('python', [path.join(__dirname, 'script.py')]);
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', data => { stdout += data; });
    py.stderr.on('data', data => { stderr += data; });

    py.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Python exited ${code}: ${stderr}`));
    });

    py.stdin.write(JSON.stringify({ text: textToProcess }));
    py.stdin.end();
  });
}