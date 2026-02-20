# Workshop Trend Calculator

A Chrome extension that calculates workshop closing recommendations from historical attendance data. Paste advisor stats from a spreadsheet and get forecasts with close/open decisions.

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the folder containing this extension
6. The extension icon will appear in your Chrome toolbar — click it to open

## Usage

The extension has three tabs:

### Paste Data
- Copy an advisor's stats block from your spreadsheet — include the advisor code in column A (e.g. `AVL`) and all rows from **Date** through **% Yes**
- Paste into the text area and click **Import / Update Advisor**
- Duplicate workshop dates for the same advisor are automatically overwritten with the latest paste

### Forecast
- After importing advisor data, this tab shows a forecast card for each advisor/location
- Enter **Current Feds**, **Current SPs**, and **Target** values
- The extension calculates projected closing numbers using recency-weighted historical trends and displays a **CLOSE** or **OPEN** recommendation

### Stored Data
- View all imported advisors and their historical workshop data
- Expand any advisor card to see a detailed table of past workshops
- Delete individual advisors or all data as needed
