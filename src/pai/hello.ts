/**
 * Hello class
 */
export class Hello {
    private readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    public say(): string {
        return `Hello ${this.name}`;
    }
}
