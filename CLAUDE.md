# MCP Server - World Bank Documents & Reports API

## Project Overview
This an AWS hosted MCP Server for The World Bank Documents and Reports API that allows for the search and retrieval of the public, Bank documents available in the Documents & Reports site.  Records can be retrieved in a format useful for research and for inclusion in web sites outside of Documents & Reports and the World Bank. 

## Environment Configuration
- AWS Account ID: 365677123675
- AWS Region: us-east-1
- AWS CLI Profile: wb-mcp
- GitHub Repository: https://github.com/Manzia/wbank-documents-reports-mcp.git
- Project Name: wbank-docs-reports-mcp
- Documents & Reports API URL: https://documents.worldbank.org/en/publication/documents-reports/api
- Runtime: Node.js 24.x
- Architecture: arm64

## Development Workflow

### Branch Strategy
- main: Production-ready code
- feature/*: Feature branches (naming: feature/TASK-ID-description)