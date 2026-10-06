---
name: Craete Webhook of Autodesk Construction Issues
description: Craete Webhook of Autodesk Construction Issues with the specific project
allowed-tools: Read, Bash, Grep, Glob
---

# Autodesk Webhooks Schema

 - the webhook is by region. By default, on US. To Read/Create/Delete webhooks of specific regions, the header must specify the region.
 - webhook normally includes: callbackUrl, scope(for Issues webhook, the scope if the project id), hookAttribute (store the custom data)

 demo:
 ```
 {
            "callbackUrl": "https://webhooktest.net/webhook/01a0d27e-d1ce-72cd-9b99-6c3ffba6a2de",
            "scope": {
                 "project": "854c194f-05b3-4117-b926-69fa36c33c0c"
            },
            "hookAttribute": {
              "mydata": "abcde",
              "test":"aaa"
            } 
      }
 ```
- the response of callback will return the data of the hook, and the payload of the hook. In the case of Issues Webhook, the payload will tell the project id, issue id, entity id (comment, attachment) etc.

demo:
```
{
  "version": "1.0",
  "resourceUrn": "urn:adsk.issues:issues.attachment:8a1c2e3d-4f5b-4a6c-9d7e-1b2c3d4e5f6a",
  "hook": {
    "hookId": "13f9a9eb-3cdb-4dc8-a04a-d12015c63d40",
    "tenant": "713c69f7-6131-4199-b260-5cd48f82a1de",
    "callbackUrl": "http://bf067e05.ngrok.io/callback",
    "createdBy": "V73BQ6TVMLWR",
    "event": "attachment.created-1.0",
    "createdDate": "2026-09-16T12:00:00.000+00:00",
    "lastUpdatedDate": "2026-09-16T12:00:00.000+00:00",
    "system": "autodesk.construction.issues",
    "creatorType": "O2User",
    "status": "active",
    "scope": {
      "project": "713c69f7-6131-4199-b260-5cd48f82a1de"
    },
    "autoReactivateHook": true,
    "urn": "urn:adsk.webhooks:events.hook:13f9a9eb-3cdb-4dc8-a04a-d12015c63d40",
    "callbackWithEventPayloadOnly": false,
    "__self__": "/systems/autodesk.construction.issues/events/attachment.created-1.0/hooks/13f9a9eb-3cdb-4dc8-a04a-d12015c63d40"
  },
  "payload":
  {
    "projectId": "713c69f7-6131-4199-b260-5cd48f82a1de",
    "id": "8a1c2e3d-4f5b-4a6c-9d7e-1b2c3d4e5f6a",
    "issueId": "520aff8e-78a5-41fd-9b39-34e89c547953",
    "createdAt": "2026-09-16T12:00:00.000Z",
    "createdBy": "V73BQ6TVMLWR"
  }
}

```
 

## Workflow

by the signed-in user's **three-legged OAuth access token** (from Autodesk sign-in for this APS app; do not use `client_credentials`), project id, events and custom data in the context, call 

  `https://developer.api.autodesk.com/webhooks/v1/systems/:system/events/:event/hooks`

  The system is **autodesk.construction.issues**
  The header **region** is what selected from the context
  the payload demo:

  ```
  {
            "callbackUrl": "https://webhooktest.net/webhook/01a0d27e-d1ce-72cd-9b99-6c3ffba6a2de",
            "scope": {
                 "project": "854c194f-05b3-4117-b926-69fa36c33c0c"
            },
            "hookAttribute": {
              "mydata": "abcde",
              "test":"aaa"
            } 
      }
  ```