import readline from 'node:readline';

export function createReadlineInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}

export function question(rl: readline.Interface, query: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            resolve(answer);
        });
    });
}

export async function text(message: string): Promise<string> {
    const rl = createReadlineInterface();
    const answer = await question(rl, message);
    rl.close();
    return answer;
}
