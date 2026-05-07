# frozen_string_literal: true

class BackfillCollectionItemCounts < ActiveRecord::Migration[8.0]
  disable_ddl_transaction!

  def up
    say_with_time 'Backfilling collections.item_count from collection_items' do
      safety_assured do
        begin
          execute "SET lock_timeout TO '5s'"

          execute <<~SQL.squish
            UPDATE collections
               SET item_count = collection_item_counts.item_count
              FROM (
                SELECT collection_id, COUNT(*) AS item_count
                  FROM collection_items
                 GROUP BY collection_id
              ) AS collection_item_counts
             WHERE collections.id = collection_item_counts.collection_id
               AND collections.item_count IS DISTINCT FROM collection_item_counts.item_count
          SQL

          execute <<~SQL.squish
            UPDATE collections
               SET item_count = 0
             WHERE collections.item_count IS DISTINCT FROM 0
               AND NOT EXISTS (
                 SELECT 1
                   FROM collection_items
                  WHERE collection_items.collection_id = collections.id
               )
          SQL
        ensure
          execute 'RESET lock_timeout'
        end
      end
    end
  end

  def down
    # Keep the denormalized counter in sync; there is no useful stale state to restore.
  end
end
