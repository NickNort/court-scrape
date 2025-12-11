// 2captcha API integration for solving Cloudflare Turnstile challenges
// Complete solution including API interaction and captcha bypass logic

interface TwoCaptchaResponse {
    status: number;
    request: string;
    error_text?: string;
}

interface TurnstileParams {
    sitekey: string;
    pageurl: string;
    data?: string;
    pagedata?: string;
    action?: string;
}

export class TwoCaptchaSolver {
    private apiKey: string;
    private baseUrl: string = 'http://2captcha.com';

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Submit Turnstile challenge to 2captcha for solving
     */
    async solveTurnstile(params: TurnstileParams, log: any): Promise<string | null> {
        try {
            log.info('🔧 Submitting Turnstile challenge to 2captcha...');
            
            // Step 1: Submit the challenge
            const taskId = await this.submitTurnstile(params, log);
            if (!taskId) {
                return null;
            }

            // Step 2: Wait for solution
            const solution = await this.waitForSolution(taskId, log);
            return solution;

        } catch (error) {
            log.error(`❌ 2captcha solving failed: ${error}`);
            return null;
        }
    }

    /**
     * Submit Turnstile challenge and get task ID
     */
    private async submitTurnstile(params: TurnstileParams, log: any): Promise<string | null> {
        const submitUrl = `${this.baseUrl}/in.php`;
        
        const formData = new URLSearchParams({
            key: this.apiKey,
            method: 'turnstile',
            sitekey: params.sitekey,
            pageurl: params.pageurl,
            json: '1'
        });

        // Add optional parameters
        if (params.data) formData.append('data', params.data);
        if (params.pagedata) formData.append('pagedata', params.pagedata);
        if (params.action) formData.append('action', params.action);

        log.info(`📤 Submitting to 2captcha with site key: ${params.sitekey}`);

        try {
            const response = await fetch(submitUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: formData.toString()
            });

            const result: TwoCaptchaResponse = await response.json();

            if (result.status === 1) {
                log.info(`✅ Task submitted successfully. Task ID: ${result.request}`);
                return result.request;
            } else {
                log.error(`❌ Failed to submit task: ${result.error_text || 'Unknown error'}`);
                return null;
            }

        } catch (error) {
            log.error(`❌ Error submitting to 2captcha: ${error}`);
            return null;
        }
    }

    /**
     * Wait for 2captcha to solve the challenge
     */
    private async waitForSolution(taskId: string, log: any): Promise<string | null> {
        const resultUrl = `${this.baseUrl}/res.php`;
        const maxAttempts = 40; // 40 attempts * 5 seconds = 3.3 minutes max wait
        
        log.info(`⏳ Waiting for 2captcha solution (Task ID: ${taskId})...`);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Wait before checking (2captcha recommends 5+ seconds between requests)
                await new Promise(resolve => setTimeout(resolve, 5000));

                const checkUrl = `${resultUrl}?key=${this.apiKey}&action=get&id=${taskId}&json=1`;
                const response = await fetch(checkUrl);
                const result: TwoCaptchaResponse = await response.json();

                if (result.status === 1) {
                    log.info(`🎉 2captcha solved the challenge! Solution: ${result.request.substring(0, 50)}...`);
                    return result.request;
                } else if (result.request === 'CAPCHA_NOT_READY') {
                    // Reduce logging frequency - only log every 5th attempt
                    if (attempt % 5 === 0) {
                        log.info(`⏳ Attempt ${attempt}/${maxAttempts}: Solution not ready yet...`);
                    }
                    continue;
                } else {
                    log.error(`❌ Error getting solution: ${result.error_text || result.request}`);
                    return null;
                }

            } catch (error) {
                log.warning(`⚠️  Error checking solution (attempt ${attempt}): ${error}`);
                continue;
            }
        }

        log.error('❌ Timeout waiting for 2captcha solution');
        return null;
    }

    /**
     * Extract Turnstile site key from page
     */
    static async extractSiteKey(page: any, log: any): Promise<string | null> {
        try {
            log.info('🔍 Extracting Turnstile site key from page...');

            // Look for site key in various places
            const siteKey = await page.evaluate(() => {
                // Method 1: Look for data-sitekey attribute
                const turnstileDiv = document.querySelector('[data-sitekey]');
                if (turnstileDiv) {
                    return turnstileDiv.getAttribute('data-sitekey');
                }

                // Method 2: Look in script tags for site key patterns
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                    const content = script.textContent || script.innerHTML;
                    const siteKeyMatch = content.match(/sitekey['":\s]*['"]([0-9a-zA-Z_-]+)['"]/i);
                    if (siteKeyMatch) {
                        return siteKeyMatch[1];
                    }
                }

                // Method 3: Look for common Turnstile site key patterns
                const bodyText = document.body.innerHTML;
                const patterns = [
                    /0x[0-9A-Fa-f]{16,}/g, // Hex pattern like 0x4AAAAAAAhseTmUbrk0U5ab
                    /[0-9A-Za-z_-]{20,}/g  // General alphanumeric pattern
                ];

                for (const pattern of patterns) {
                    const matches = bodyText.match(pattern);
                    if (matches) {
                        // Return the first match that looks like a site key
                        for (const match of matches) {
                            if (match.startsWith('0x') && match.length >= 20) {
                                return match;
                            }
                        }
                    }
                }

                return null;
            });

            if (siteKey) {
                log.info(`✅ Found Turnstile site key: ${siteKey}`);
                return siteKey;
            } else {
                log.warning('❌ Could not extract Turnstile site key from page');
                return null;
            }

        } catch (error) {
            log.error(`❌ Error extracting site key: ${error}`);
            return null;
        }
    }

    /**
     * Submit the solved token to the page
     */
    static async submitSolution(page: any, token: string, log: any): Promise<boolean> {
        try {
            log.info('📝 Submitting 2captcha solution to page...');

            // Set the token in BOTH hidden input fields (Turnstile AND reCAPTCHA)
            const success = await page.evaluate((solutionToken: string) => {
                let fieldsSet = 0;
                
                // Set Turnstile response field
                const turnstileInput = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement;
                if (turnstileInput) {
                    turnstileInput.value = solutionToken;
                    
                    // Trigger change events
                    const event = new Event('change', { bubbles: true });
                    turnstileInput.dispatchEvent(event);
                    
                    fieldsSet++;
                }
                
                // Set reCAPTCHA response field with the same token
                const recaptchaInput = document.querySelector('input[name="g-recaptcha-response"]') as HTMLInputElement;
                if (recaptchaInput) {
                    recaptchaInput.value = solutionToken;
                    
                    // Trigger change events
                    const event = new Event('change', { bubbles: true });
                    recaptchaInput.dispatchEvent(event);
                    
                    fieldsSet++;
                }
                
                return fieldsSet > 0;
            }, token);

            if (success) {
                log.info('✅ Solution token set in both Turnstile and reCAPTCHA fields');
                
                // Wait a moment for any JavaScript processing
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Debug: Analyze the form before submission
                const formAnalysis = await page.evaluate(() => {
                    const form = document.querySelector('form');
                    if (form) {
                        const formData = new FormData(form);
                        const formFields: any = {};
                        for (let [key, value] of formData.entries()) {
                            formFields[key] = value;
                        }
                        return {
                            action: form.action,
                            method: form.method,
                            fields: formFields,
                            hasForm: true
                        };
                    }
                    return { hasForm: false };
                });
                
                // Get current URL before submission
                const urlBeforeSubmit = page.url();
                
                // Try to find and submit the form
                const formSubmitted = await page.evaluate(() => {
                    const form = document.querySelector('form');
                    if (form) {
                        form.submit();
                        return true;
                    }
                    
                    // Look for submit button
                    const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
                    if (submitBtn) {
                        (submitBtn as HTMLElement).click();
                        return true;
                    }
                    
                    return false;
                });

                if (formSubmitted) {
                    log.info('✅ Form submitted with 2captcha solution');
                    
                    // Wait for potential redirect/response
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Check what happened after submission
                    const urlAfterSubmit = page.url();
                    const pageTitle = await page.title();
                    
                    // Check if URL changed (indicating redirect)
                    if (urlAfterSubmit !== urlBeforeSubmit) {
                        log.info('🎉 Page redirected after form submission!');
                        
                        // Check if we got a session ID
                        if (urlAfterSubmit.includes('SessionID=')) {
                            const sessionMatch = urlAfterSubmit.match(/SessionID=([A-Fa-f0-9]+)/);
                            if (sessionMatch) {
                                log.info(`🎯 SUCCESS! Extracted SessionID: ${sessionMatch[1]}`);
                            }
                        }
                        
                        return true;
                    } else {
                        log.warning('⚠️  No redirect occurred after form submission');
                        return false;
                    }
                    
                } else {
                    log.warning('⚠️  Solution set but could not find form to submit');
                    return false;
                }
                
            } else {
                log.error('❌ Could not find cf-turnstile-response input field');
                return false;
            }

        } catch (error) {
            log.error(`❌ Error submitting solution: ${error}`);
            return false;
        }
    }
}

// Initialize with API key from environment variable
const apiKey = process.env.TWOCAPTCHA_API_KEY;
if (!apiKey) {
    throw new Error('TWOCAPTCHA_API_KEY environment variable is required');
}
export const twoCaptchaSolver = new TwoCaptchaSolver(apiKey);

/**
 * Bypass Turnstile captcha using 2captcha service
 */
export async function bypassTurnstileWith2Captcha(page: any, log: any): Promise<boolean> {
    log.info('🎯 Starting Turnstile bypass with 2captcha...');
    
    try {
        // Step 1: Extract site key from the page
        const siteKey = await TwoCaptchaSolver.extractSiteKey(page, log);
        if (!siteKey) {
            log.error('❌ Could not extract Turnstile site key - cannot proceed with 2captcha');
            return false;
        }

        // Step 2: Get current page URL
        const pageUrl = page.url();

        // Step 3: Submit to 2captcha for solving
        const solution = await twoCaptchaSolver.solveTurnstile({
            sitekey: siteKey,
            pageurl: pageUrl
        }, log);

        if (!solution) {
            log.error('❌ 2captcha failed to solve the Turnstile challenge');
            return false;
        }

        // Step 4: Submit the solution to the page
        const submitted = await TwoCaptchaSolver.submitSolution(page, solution, log);
        
        if (submitted) {
            log.info('🎉 Turnstile bypass completed successfully with 2captcha!');
            
            // Wait for page to process the solution
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Check if we were redirected or if the captcha is gone
            const newUrl = page.url();
            if (newUrl !== pageUrl) {
                log.info(`✅ Page redirected to: ${newUrl}`);
                return true;
            }
            
            // Check if captcha elements are gone
            const captchaStillPresent = await page.evaluate(() => {
                return document.querySelector('input[name="cf-turnstile-response"]') !== null;
            });
            
            if (!captchaStillPresent) {
                log.info('✅ Captcha elements removed from page');
                return true;
            }
            
            log.info('✅ Solution submitted - assuming success');
            return true;
            
        } else {
            log.error('❌ Failed to submit 2captcha solution to page');
            return false;
        }

    } catch (error) {
        log.error(`❌ Error in 2captcha bypass: ${error}`);
        return false;
    }
}

/**
 * Main captcha bypass function that tries 2captcha first
 */
export async function bypassCaptchaWith2Captcha(page: any, log: any, maxAttempts: number = 2): Promise<boolean> {
    log.info('🎯 Starting enhanced captcha bypass with 2captcha...');
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log.info(`📝 Captcha bypass attempt ${attempt}/${maxAttempts}`);
        
        // Check if we're on a captcha page
        const pageUrl = page.url();
        const pageTitle = await page.title();
        
        // Detect if this looks like a captcha page
        const isCaptchaPage = pageUrl.includes('captcha') || 
                             pageUrl.includes('challenge') ||
                             pageTitle.toLowerCase().includes('captcha') ||
                             pageTitle.toLowerCase().includes('challenge');
        
        if (!isCaptchaPage) {
            log.info('✅ Not on captcha page - bypass not needed');
            return true;
        }
        
        log.info('🎯 Detected captcha page, attempting 2captcha bypass...');
        
        // Try 2captcha bypass
        const success = await bypassTurnstileWith2Captcha(page, log);
        
        if (success) {
            log.info('🎉 2captcha bypass successful!');
            return true;
        }
        
        if (attempt < maxAttempts) {
            log.info(`⏳ Waiting before retry attempt ${attempt + 1}...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    log.error('❌ All 2captcha bypass attempts failed');
    return false;
}
