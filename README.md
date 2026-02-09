# Email Sync Integration - Netlify Deployment

## 📦 What's Included

This folder contains everything needed to deploy the email sync integration to Netlify.

## 🚀 Deployment Steps

### 1. Push to GitHub (if not already)

```bash
cd netlify-deploy
git init
git add .
git commit -m "Initial commit for Netlify deployment"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Deploy to Netlify

1. Go to https://app.netlify.com
2. Click "Add new site" → "Import an existing project"
3. Connect your GitHub repository
4. Configure build settings:
   - **Build command:** (leave empty)
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions`

### 3. Add Environment Variable

In Netlify dashboard:
1. Go to Site settings → Environment variables
2. Add variable:
   - **Key:** `HUBSPOT_API_KEY`
   - **Value:** `your_hubspot_api_key_here`

### 4. Deploy!

Click "Deploy site" - Netlify will:
- Build your site
- Deploy functions
- Give you a URL like: `https://your-site.netlify.app`

### 5. Update HubSpot Webhook

1. Go to HubSpot → Settings → Webhooks
2. Update the webhook URL to:
   ```
   https://your-site.netlify.app/webhooks/email-sync
   ```
3. Save

## ✅ Testing

Visit your Netlify URL:
- Homepage: `https://your-site.netlify.app`
- Test connection using the button
- Webhook endpoint: `https://your-site.netlify.app/webhooks/email-sync`

## 🎯 What It Does

- Receives HubSpot webhook events
- Parses emails for loan numbers
- Finds matching deals
- Associates emails to deals automatically
- Works for: presentationscheduled, closedwon, sold stages

## 📊 Monitoring

View logs in Netlify:
1. Go to Functions tab
2. Click on `email-sync`
3. View function logs in real-time

## 🔒 Security

- API key stored as environment variable (not in code)
- HTTPS by default
- Serverless (auto-scales, no server management)
