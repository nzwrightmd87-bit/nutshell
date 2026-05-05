# Example Task Directive

## Goal
Define the business outcome this task must achieve.

## Inputs
- Required files, parameters, IDs, and environment variables.

## Execution Scripts
- Primary: `execution/example_script.py`
- Fallback: _Add alternatives here if needed._

## Procedure
1. Validate inputs are present.
2. Run the execution script with explicit arguments.
3. Store intermediate files in `.tmp/` only.
4. Publish final output to the target cloud service.

## Expected Output
Describe the final deliverable location and format.

## Edge Cases
- Missing input files
- Invalid credentials
- External API failures or rate limits

## Recovery
1. Read the error details.
2. Fix script/config issues.
3. Re-run.
4. Update this directive with the learning.
