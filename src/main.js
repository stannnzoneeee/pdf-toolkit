const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const fetch = require('node-fetch');
const path = require('path');
const FormData = require('form-data');

// --- SECURITY WARNING ---
// Avoid hardcoding API keys. Use environment variables or a secure config method.
const GEMINI_API_KEY = "AIzaSyBoU4rLXmpHiWG7BivRjczwxULVvz_3UYg"; // Replace with secure method
// It seems you have a ConvertAPI key hardcoded here too. SECURITY WARNING applies.
const CONVERT_API_AUTH = 'Bearer secret_zb9SXtRqDYzXYG6K'; // Replace with secure method

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Note: enableRemoteModule is deprecated and potentially insecure.
      // Consider alternatives if possible for future development.
      enableRemoteModule: true
    }
  });

  // Ensure the path to index.html is correct relative to the main process file
  mainWindow.loadFile(path.join(__dirname, 'index.html')); // More robust path joining
  // mainWindow.webContents.openDevTools(); // Uncomment for debugging
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Standard macOS behavior
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // Standard macOS behavior - Re-create window if dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Handles the request from the renderer to open the file dialog
ipcMain.handle('dialog:openFile', async () => {
  // Ensure mainWindow is available before showing dialog
  if (!mainWindow) {
      console.error("Main window not available for dialog.");
      return [];
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { // Pass parent window
    properties: ['openFile', 'multiSelections'], // Allow multiple files
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });
  if (canceled || !filePaths || filePaths.length === 0) {
    return []; // Return empty array if canceled or no path selected
  }
  return filePaths; // Return array with the selected path(s)
});

// Handles the PDF processing request from the renderer for multiple files
ipcMain.handle('pdf:parse', async (event, pdfPaths) => {
  if (!Array.isArray(pdfPaths) || pdfPaths.length === 0) {
    return { success: false, error: 'No PDF paths provided or invalid format.' };
  }

  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < pdfPaths.length; i++) {
    const pdfPath = pdfPaths[i];
    const originalFilename = path.basename(pdfPath); // Get original filename for reporting

    // Send progress update before starting processing this file
    event.sender.send('pdf:progress', { index: i, total: pdfPaths.length, originalFilename, status: 'processing' });

    try {
      // --- Step 1: Convert PDF to Text using ConvertAPI ---
      console.log(`Starting PDF processing for: ${pdfPath}`);
      const convertApiForm = new FormData();
      if (!fs.existsSync(pdfPath)) {
          throw new Error(`File not found`); // Simpler error message for UI
      }
      convertApiForm.append('File', fs.createReadStream(pdfPath));
      convertApiForm.append('StoreFile', 'true'); // Need the URL to download the text
      convertApiForm.append('OutputType', 'txt');

      const convertApiResponse = await fetch('https://v2.convertapi.com/convert/pdf/to/ocr', {
        method: 'POST',
        headers: {
          Authorization: CONVERT_API_AUTH, // Use constant
          ...convertApiForm.getHeaders()
        },
        body: convertApiForm
      });

      if (!convertApiResponse.ok) {
        let errorMsg = 'ConvertAPI request failed';
        try {
          const errorText = await convertApiResponse.text();
          try {
              const errorJson = JSON.parse(errorText);
              errorMsg = errorJson.Message || `ConvertAPI Error ${convertApiResponse.status}: ${errorText}`;
          } catch (jsonError) {
               errorMsg = `ConvertAPI Error ${convertApiResponse.status}: ${errorText}`;
          }
        } catch (e) {
          errorMsg = `ConvertAPI Error ${convertApiResponse.status}: ${convertApiResponse.statusText}`;
        }
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      const convertApiResult = await convertApiResponse.json();
      const textFileUrl = convertApiResult.Files?.[0]?.Url;

      if (!textFileUrl) {
        console.error('No converted text file URL found in ConvertAPI response:', convertApiResult);
        throw new Error('Could not retrieve converted text file URL from ConvertAPI.');
      }
      console.log('Text extraction successful, URL:', textFileUrl);

      // --- Step 2: Fetch the Extracted Text ---
      const textResponse = await fetch(textFileUrl);
      if (!textResponse.ok) {
          throw new Error(`Failed to fetch extracted text (${textFileUrl}): ${textResponse.status} ${textResponse.statusText}`);
      }
      const extractedText = await textResponse.text();
      console.log('Successfully fetched extracted text.');

      // --- Step 3: Analyze Text with Gemini API ---
      const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

      const prompt = `
Analyze the following text extracted from a document:
--- TEXT START ---
${extractedText}
--- TEXT END ---

Identify the document type (Invoice, Credit Note, or Statement). Extract the following information:
- Vendor Name
- Store Name
- Invoice Number (if it's an Invoice)
- Credit Note Number (if it's a Credit Note)
- Date (format as 'Month Year', e.g., 'March 2023'. If multiple dates exist, try to find the main document date like invoice date, statement date, or credit note date.)

Return the result ONLY as a JSON object with these exact keys: "documentType", "vendorName", "storeName", "invoiceNo", "creditNoteNo", "date".
Use "N/A" if a value cannot be found. Example:
{
  "documentType": "Invoice",
  "vendorName": "Example Corp",
  "storeName": "Main Branch",
  "invoiceNo": "INV-12345",
  "creditNoteNo": "N/A",
  "date": "March 2023"
}
`;

      console.log('Sending request to Gemini API...');
      const geminiResponse = await fetch(geminiApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      if (!geminiResponse.ok) {
        const errorDetails = await geminiResponse.text();
        const errorMsg = `Gemini API request failed: ${geminiResponse.status} ${geminiResponse.statusText} - ${errorDetails}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      const geminiResult = await geminiResponse.json();
      const generatedText = geminiResult?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!generatedText) {
          console.error('Failed to get valid response text from Gemini API. Response:', JSON.stringify(geminiResult, null, 2));
          throw new Error('Failed to get valid response text from Gemini API.');
      }
      console.log('Received response from Gemini API.');

      // --- Step 4: Parse Gemini Response ---
      let parsedInfo;
      try {
          const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
              console.error("Could not find JSON object in AI response:", generatedText);
              throw new Error("No valid JSON object found in the AI response.");
          }
          const potentialJson = jsonMatch[0];
          parsedInfo = JSON.parse(potentialJson);
          console.log('Successfully parsed Gemini JSON response:', parsedInfo);
      } catch (parseError) {
          console.error("Failed to parse Gemini JSON response. Raw text received:", generatedText);
          throw new Error(`Failed to parse identification data from AI: ${parseError.message}`);
      }

      // --- Step 5: Construct Filename ---
      let fileNameParts = [];
      const {
        documentType,
        vendorName = 'VendorName',
        storeName = 'StoreName',
        invoiceNo = 'InvoiceNo',
        creditNoteNo = 'CreditNoteNo',
        date = 'Date'
      } = parsedInfo;

      if (documentType === 'Invoice') {
        fileNameParts = [vendorName, storeName, 'Tax Invoice', invoiceNo, date];
      } else if (documentType === 'Credit Note') {
        fileNameParts = [vendorName, storeName, 'Credit Note', creditNoteNo, date];
      } else if (documentType === 'Statement') {
        fileNameParts = [vendorName, storeName, 'Statement', date];
      } else {
        fileNameParts = [vendorName, storeName, documentType || 'UnknownDocument', date];
      }

      const placeholders = ['N/A', 'InvoiceNo', 'CreditNoteNo', 'VendorName', 'StoreName', 'Date', 'UnknownDocument'];
      const filenameBase = fileNameParts
          .map(part => String(part || '').replace(/[\/\\?%*:|"<>]/g, '-').trim())
          .filter(part => part && !placeholders.includes(part))
          .join('_');

      const finalFilenameWithExt = filenameBase ? `${filenameBase}.pdf` : `Processed_${path.basename(pdfPath, '.pdf')}_${Date.now()}.pdf`; // Include original name part in fallback
      console.log(`Generated filename: ${finalFilenameWithExt}`);

      // --- Step 6: Copy and Rename PDF ---
      const originalDir = path.dirname(pdfPath);
      const newFilePath = path.join(originalDir, finalFilenameWithExt);

      try {
          await fs.promises.copyFile(pdfPath, newFilePath);
          console.log(`Successfully copied and renamed PDF to: ${newFilePath}`);
      } catch (copyError) {
          console.error(`Error copying file from ${pdfPath} to ${newFilePath}:`, copyError);
          throw new Error(`Failed to copy/rename the PDF file: ${copyError.message}`);
      }

      // --- Step 7: Record Success and Send Progress ---
      const successResult = {
        originalFilename,
        success: true,
        filename: finalFilenameWithExt,
        newFilePath: newFilePath,
        // rawText: extractedText // Omit raw text from summary to avoid large IPC messages
      };
      results.push(successResult);
      successCount++;
      event.sender.send('pdf:progress', { index: i, total: pdfPaths.length, originalFilename, status: 'success', result: successResult });

    } catch (err) {
      // --- Step 7b: Record Failure and Send Progress ---
      console.error(`Error processing ${originalFilename}:`, err);
      const errorResult = {
        originalFilename,
        success: false,
        error: err.message || 'An unknown error occurred.'
      };
      results.push(errorResult);
      failCount++;
      event.sender.send('pdf:progress', { index: i, total: pdfPaths.length, originalFilename, status: 'error', result: errorResult });
    }
  } // End of loop

  // --- Step 8: Return Final Summary ---
  console.log(`Batch processing complete. Success: ${successCount}, Failed: ${failCount}`);
  return { overallSuccess: failCount === 0, totalFiles: pdfPaths.length, successful: successCount, failed: failCount, results }; // results might be large, consider omitting if not needed by renderer summary
});

// Handles request from renderer to open a file path in the system shell
ipcMain.on('shell:openPath', (event, filePath) => {
  if (!filePath) {
    console.error('Attempted to open null/undefined path.');
    return;
  }
  console.log(`Request received to show item in folder: ${filePath}`);
  // Use shell.showItemInFolder to open the containing folder and select the file
  shell.showItemInFolder(filePath);
});
