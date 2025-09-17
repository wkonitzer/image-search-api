# Chainguard Images API Proxy

This project provides a Cloudflare Worker that turns the public  
[images.chainguard.dev](https://images.chainguard.dev) catalog into a JSON API.  

It crawls the `/directory` pages, stores results in Cloudflare R2,  
and exposes a clean searchable API with pagination and wildcard search.

---

## Features

- 🗂️ **Catalog API**: browse and search all images from images.chainguard.dev  
- 🔍 **Wildcard search**: supports exact, prefix (`node*`), suffix (`*node`), and contains (`*node*`) queries  
- 💾 **R2-backed snapshot**: image list stored in R2 bucket for fast reads  
- ♻️ **Incremental crawling**: fetches directory pages in safe small batches  
- ⏲️ **Auto-refresh**: cron job runs every minute; once per day the crawl resets from the beginning to catch new images inserted alphabetically  
- 🔒 **Admin endpoints**: protected by an API key (`x-admin-key` header)

---

## Setup

### 1. Deploy Worker
Clone the repo and publish the Worker to Cloudflare:

### 2. Bindings
In the Cloudflare dashboard, configure:
IMAGES_BUCKET: R2 bucket where the snapshot JSON is stored
ADMIN_KEY: secret string used to protect admin endpoints

[secret]

```
ADMIN_KEY = "your-secret-key"
```

[r2_buckets]

```
binding = "IMAGES_BUCKET"
bucket_name = "chainguard-images"
```

### 3. Schedule cron
Add a cron trigger to run the crawler once per minute:

[triggers]

```
crons = ["*/1 * * * *"]
```

The Worker increments an internal counter; once it reaches 1440 ticks (~1 day),
it resets the crawl from the start.

### API Endpoints

#### Public
```
GET /v1/status
```

Returns snapshot status:
```
{
  "total": 1666,
  "cursor": 279,
  "complete": true,
  "lastPage": 278,
  "lastUpdated": 1756234998,
  "cronTicks": 12
}
```

Paginated list of images
```
GET /v1/images
```
Returns a paginated list of images sorted alphabetically. Supports both paginated and bulk/all modes.

Query Parameters
- page (integer ≥ 1) – Page number to return.
- size (integer 1–1000 or "all") – Number of items per page. Use "all" to fetch the full dataset in one request.

Response Format
All responses (success or error) follow the same schema:
```
{
  "meta": {
    "status": "success",        // "success" or "error"
    "version": "v1",            // API version
    "schemaVersion": "1.0.0",   // Response schema version
    "requestId": "uuid",        // Unique request identifier
    "timestamp": "ISO-8601",    // Server timestamp
    "durationMs": 12,           // Processing time in ms
    "cache": "HIT",             // "HIT" or "MISS"
    "source": "snapshot",       // Data source ("snapshot", "db", "api", etc.)
    "warnings": [],             // Non-fatal issues, e.g. deprecated params
    "limits": {                 // Server-side constraints
      "maxSize": 1000,
      "maxPages": 1000000000
    },

    // Pagination metadata
    "total": 2000,              // Total number of items available
    "count": 200,               // Number of items returned in this page
    "remaining": 1800,          // Number of items left after this page
    "percentComplete": 10,      // Completion relative to total
    "page": 1,                  // Current page number
    "size": 200,                // Requested page size
    "pages": 10,                // Total number of pages
    "offset": 0,                // Starting index (0-based)
    "end": 199,                 // Ending index (0-based)
    "range": "1–200",           // Human-friendly range

    // Navigation helpers
    "hasPrev": false,
    "hasNext": true,
    "prevPage": null,
    "nextPage": 2,
    "firstPage": 1,
    "lastPage": 10,

    // HATEOAS links
    "links": {
      "self": "https://.../v1/images?page=1&size=200",
      "first": "https://.../v1/images?page=1&size=200",
      "last": "https://.../v1/images?page=10&size=200",
      "prev": null,
      "next": "https://.../v1/images?page=2&size=200"
    }
  },
  "items": [ ... ]              // Array of image objects
}
```

Example Requests"
- First page of 200 images
```
GET /v1/images?page=1&size=200
```
- Third page of 500 images
```
GET /v1/images?page=3&size=500
```
- All images in one response
```
GET /v1/images?size=all
```

Error Responses
Errors share the same schema as success responses, with status: "error" and an HTTP status code:
```
{
  "meta": {
    "status": "error",
    "version": "v1",
    "schemaVersion": "1.0.0",
    "requestId": "uuid",
    "timestamp": "ISO-8601",
    "code": 400,
    "message": "Invalid 'size' parameter. Must be between 1 and 1000.",
    "cache": "MISS",
    "source": "snapshot",
    "warnings": [],
    "limits": {
      "maxSize": 1000,
      "maxPages": 1000000000
    }
  },
  "items": []
}
```

Search by name:
```
GET /v1/search?q=node
```

supports:
- node → exact match
- node* → starts with
- *node → ends with
- *node* → contains

#### Admin (require x-admin-key header)
Crawl the next N pages (safe batch).
```
POST /admin/build?steps=8
```

Manually set the last directory page.
```
POST /admin/set-lastpage?value=278
```

Reset cursor=1 and complete=false but keep existing items.
```
POST /admin/restart-crawl
```

Re-normalize snapshot, dropping bad entries.
```
POST /admin/repair
```

Sort and rewrite snapshot.
```
POST /admin/compact
```

Wipe everything and start over.
```
POST /admin/reset
```

### How It Works
#### Crawler
- Fetches /directory/1, /directory/2, … until lastPage.
- Extracts image slugs from <a href="/directory/image/...">.
- Deduplicates and stores them in R2.

#### Snapshot
Saved in R2 as catalog.json with:
```
{
  "items": [{ "name": "nginx", "url": "https://images.chainguard.dev/directory/image/nginx" }],
  "seen": {},
  "cursor": 42,
  "lastPage": 278,
  "complete": false,
  "lastUpdated": 1756234998,
  "cronTicks": 123
}
```

#### Auto-refresh
- Cron runs every minute.
- Increments cronTicks.
- When cronTicks >= 1440, the crawl resets from the start.
- Ensures new images inserted alphabetically are picked up.

### Example Usage
Get catalog status
```
curl https://your-worker.workers.dev/v1/status
```

List first 5 images
```
curl "https://your-worker.workers.dev/v1/images?page=1&size=5"
```

Search for node-related images
```
curl "https://your-worker.workers.dev/v1/search?q=*node*"
```

Trigger a manual crawl batch
```
curl -X POST "https://your-worker.workers.dev/admin/build?steps=10" \
     -H "x-admin-key: your-secret-key"
```

### Notes
- This Worker is read-only; it never modifies images.chainguard.dev.
- R2 storage is minimal (a few KB for ~2k slugs).
- New images will typically appear in the API within a day due to the daily reset.

