import eslint from '@eslint/js';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['node_modules/', '.aws-sam/', 'coverage/'] },
    eslint.configs.recommended,
    tseslint.configs.recommended,
    // Keep last: runs Prettier as an ESLint rule and turns off the rules that conflict with it.
    prettierRecommended,
);
