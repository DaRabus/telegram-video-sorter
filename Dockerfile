# Use Node.js 22 Alpine for smaller image size
FROM node:22-alpine

# Install dependencies for building native modules
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source files and config
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript code
RUN npm run build

# Create data directory for persistence
RUN mkdir -p /app/data

# Set environment variable to indicate Docker environment
ENV NODE_ENV=production

# Run the sorter script
CMD ["npm", "start"]
