import { createPlaywrightRouter, Dataset } from 'crawlee';
import { Actor } from 'apify';
import { bypassCaptchaWith2Captcha } from './twocaptcha.js';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, log, enqueueLinks }) => {
    log.info(`Processing start page: ${page.url()}`);

    // 1. Locate & Click "Access Now" under "Civil Case Query"
    // Use a robust XPath to find the "Access Now" link that follows the "Civil Case Query" text.
    // This finds an element containing "Civil Case Query" and then looks for the first following "Access Now" link.
    const accessNowSelector = 'xpath=//*[contains(text(), "Civil Case Query")]/following::a[contains(text(), "Access Now")]';
    
    log.info('Looking for "Access Now" button under Civil Case Query...');
    
    // Get initial pages to detect new tab
    const context = page.context();
    const initialPages = context.pages();
    
    try {
        await page.waitForSelector(accessNowSelector, { timeout: 10000 });
        log.info('Clicking "Access Now" button (will open new tab)...');
        await page.click(accessNowSelector);
    } catch (e) {
        log.warning('Specific XPath selector failed, trying looser text match for "Access Now"...');
        await page.getByText('Access Now').click();
    }

    // 2. Wait for new tab to open and detect it
    log.info('Waiting for new tab to open...');
    let newPage = null;
    
    // Poll for new page with timeout
    for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const currentPages = context.pages();
        const newPages = currentPages.filter(p => !initialPages.includes(p));
        
        if (newPages.length > 0) {
            newPage = newPages[0];
            break;
        }
        
        log.info(`Attempt ${attempt + 1}/10: Waiting for new tab...`);
    }
    
    if (!newPage) {
        throw new Error('New tab did not open after clicking Access Now');
    }
    
    // Wait for the new page to load
    await newPage.waitForLoadState('domcontentloaded');
    await new Promise(resolve => setTimeout(resolve, 2000)); // Additional wait for stability
    
    log.info(`✅ New tab opened: ${newPage.url()}`);
    
    // 3. Handle captcha with 2captcha service on the NEW TAB
    log.info('Running 2captcha bypass on the captcha tab...');
    
    const captchaBypassSuccess = await bypassCaptchaWith2Captcha(newPage, log, 2);
    
    if (captchaBypassSuccess) {
        log.info('✅ Captcha bypass completed successfully');
        
        // Wait for page to settle after captcha bypass
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Switch our working page to the new tab for subsequent operations
        page = newPage;
        
    } else {
        log.error('❌ 2captcha bypass failed on captcha tab');
        throw new Error('Failed to bypass captcha on new tab');
    }

    // 3. Click "Search by New Filings"
    log.info('Clicking "Search by New Filings"...');
    await page.getByText('Search by New Filings').click();
    
    // 4. Click "Search"
    // This usually reveals the search form or executes a default search.
    // Assuming we just need to click "Search" button now.
    log.info('Clicking "Search"...');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    
    // 5. Wait for results
    log.info('Waiting for search results table...');
    // Wait for the results table to load. "Case Number" is a likely column header.
    try {
        await page.getByText('Case Number').first().waitFor({ timeout: 30000 });
    } catch (e) {
        log.warning('Did not find "Case Number" text. Search might have returned no results or layout is different.');
    }
    
    // 6. Enqueue Case Details
    // Target the table rows. We want the links in the "Case Number" column.
    // We'll enqueue all links found in the table body to be safe, filtering for case-like URLs if possible.
    log.info('Enqueueing case details...');
    
    // Refined selector: Look for links inside table cells.
    // Often there's a specific class, but generic 'tr td a' is usually safe for data tables.
    await enqueueLinks({
        selector: 'table tbody tr td a',
        label: 'CASE_DETAIL',
        transformRequestFunction: (req) => {
            // Optional: Filter URLs here if needed.
            // For now, accept all links from the table.
            return req;
        }
    });
});

router.addHandler('CASE_DETAIL', async ({ request, page, log }) => {
    log.info(`Processing case details: ${request.url}`);
    
    // 1. Locate "Document" column/table
    // Wait for the page to load the documents table.
    try {
        // Look for "Document" header or similar
        await page.getByText('Document').first().waitFor({ timeout: 15000 });
    } catch (e) {
        log.warning(`No "Document" column found on ${request.url}, skipping or page empty.`);
        return;
    }

    // 2. Iterate rows and download
    // We look for rows that contain a "View" button/link.
    const viewButtons = page.locator('tr').filter({ hasText: 'View' }).getByText('View');
    const count = await viewButtons.count();
    
    log.info(`Found ${count} documents to download.`);
    
    for (let i = 0; i < count; i++) {
        // We re-query the button to avoid stale element handle issues if the DOM updates
        const button = viewButtons.nth(i);
        
        try {
            // Setup download listener
            const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
            
            // Click the view button
            await button.click();
            
            // Wait for download to start
            const download = await downloadPromise;
            
            const suggestedFilename = download.suggestedFilename();
            log.info(`Downloading file: ${suggestedFilename}`);
            
            // Get a readable stream of the file
            const stream = await download.createReadStream();
            
            // Generate a unique key for the KV store
            // Sanitizing filename and adding a timestamp/index to prevent collisions
            const safeFilename = suggestedFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
            const key = `PDF_${Date.now()}_${i}_${safeFilename}`;
            
            // Save to Key-Value Store
            await Actor.setValue(key, stream, { contentType: 'application/pdf' });
            
            // Push metadata to Dataset
            await Dataset.pushData({
                caseUrl: request.url,
                documentIndex: i,
                filename: suggestedFilename,
                kvStoreKey: key,
                downloadedAt: new Date().toISOString(),
                fileSize: 'unknown', // We can get actual size from stream if needed
            });
            
            log.info(`Document ${i + 1} saved as ${key}`);
            
        } catch (e) {
            log.warning(`Failed to download document ${i + 1}: ${e}`);
        }
        
        // Add a small delay between downloads to be polite
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
});
